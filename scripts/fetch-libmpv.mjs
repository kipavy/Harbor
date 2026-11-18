import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const libDir = join(root, "src-tauri", "libmpv");
const dest = join(libDir, "libmpv-2.dll");
const digest = (buf) => createHash("sha256").update(buf).digest("hex");

if (process.platform !== "win32" && !process.env.HARBOR_LIBMPV_FORCE) {
  console.log("[libmpv] not Windows, skipping (mac and linux link system libmpv)");
  process.exit(0);
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}

async function download(url) {
  console.log(`[libmpv] fetching ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText})`);
  return Buffer.from(await res.arrayBuffer());
}

if (process.arch === "arm64") {
  // The x64 DLL rides on Harbor's own libmpv release. There is no ARM64 counterpart there, so the
  // ARM64 build takes libmpv from the same shinchiro mpv-winbuild release that fetch-mpv.mjs pins.
  // The MinGW import library ships in the same archive; the MSVC linker reads it as mpv.lib, and
  // build.rs points the ARM64 link at it instead of the checked-in x64 mpv.lib.
  const RELEASE = "20261010";
  const ASSET = "mpv-dev-aarch64-20261010-git-b2c255c13e.7z";
  const ARCHIVE_SHA256 = "79f01f523cba1c958b7b1bfc85746dc8d11fee821fc032769742995c914e36be";
  const DLL_SHA256 = "1f3b3d897c94eeb4f718beb3335527d21dac5f7ed40ad2f872165da7346bd2a5";
  const importLib = join(libDir, "arm64", "mpv.lib");

  if (
    existsSync(dest) &&
    existsSync(importLib) &&
    digest(readFileSync(dest)) === DLL_SHA256
  ) {
    console.log("[libmpv] ARM64 libmpv-2.dll already present and verified");
    process.exit(0);
  }

  const url =
    process.env.HARBOR_LIBMPV_URL ??
    `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${RELEASE}/${ASSET}`;
  const temp = mkdtempSync(join(tmpdir(), "harbor-libmpv-"));
  try {
    const bytes = await download(url);
    const got = digest(bytes);
    if (got !== ARCHIVE_SHA256) {
      throw new Error(`checksum mismatch (expected ${ARCHIVE_SHA256}, got ${got})`);
    }
    const archive = join(temp, ASSET);
    writeFileSync(archive, bytes);
    const extracted = join(temp, "extracted");
    mkdirSync(extracted);
    try {
      execFileSync("7z", ["x", "-y", archive, `-o${extracted}`], { stdio: "inherit" });
    } catch {
      throw new Error("extraction failed; install 7-Zip and ensure `7z` is on PATH");
    }
    const dll = findFile(extracted, "libmpv-2.dll");
    const lib = findFile(extracted, "libmpv.dll.a");
    if (!dll || !lib) throw new Error("libmpv-2.dll or libmpv.dll.a missing from the archive");
    const dllDigest = digest(readFileSync(dll));
    if (dllDigest !== DLL_SHA256) {
      throw new Error(`libmpv-2.dll mismatch (expected ${DLL_SHA256}, got ${dllDigest})`);
    }
    mkdirSync(dirname(importLib), { recursive: true });
    copyFileSync(dll, dest);
    copyFileSync(lib, importLib);
    console.log(`[libmpv] wrote ${dest} and ${importLib}`);
  } catch (err) {
    console.error(`[libmpv] ${err.message}`);
    console.error(
      "[libmpv] set HARBOR_LIBMPV_URL to a mirror, or drop libmpv-2.dll into src-tauri/libmpv/ and libmpv.dll.a as src-tauri/libmpv/arm64/mpv.lib by hand",
    );
    process.exit(1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  process.exit(0);
}

const SHA256 = "0a81c004aae0ee7d512b9a26e38f66281f9591e84e1663215cc3a36a4bde6f6a";
// The pinned DLL rides on the Windows libmpv release; the SHA-256 below is the authority.
const TAG = process.env.HARBOR_LIBMPV_TAG ?? "libmpv-windows-x64";
const url =
  process.env.HARBOR_LIBMPV_URL ??
  `https://github.com/Harborofficial/Harbor/releases/download/${TAG}/libmpv-2.dll`;

if (existsSync(dest) && digest(readFileSync(dest)) === SHA256) {
  console.log("[libmpv] libmpv-2.dll already present and verified");
  process.exit(0);
}

console.log(`[libmpv] fetching ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`[libmpv] download failed (${res.status} ${res.statusText})`);
  console.error(
    "[libmpv] set HARBOR_LIBMPV_URL to a mirror, or drop libmpv-2.dll into src-tauri/libmpv/ by hand",
  );
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const got = digest(buf);
if (got !== SHA256) {
  console.error(`[libmpv] checksum mismatch (expected ${SHA256}, got ${got})`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, buf);
console.log(`[libmpv] wrote ${dest} (${(buf.length / 1048576).toFixed(1)} MB)`);
