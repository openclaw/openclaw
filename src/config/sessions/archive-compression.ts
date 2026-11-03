// Zstd compression for archived transcript artifacts (Codex-style cold tier).
// Archives are kept long-term by default, so compressing them is what keeps
// "never delete conversations" cheap: JSONL transcripts compress ~10:1.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { walkDirectorySync } from "@openclaw/fs-safe/walk";
import { hasErrnoCode } from "../../infra/errno.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { decodeSessionArchiveBytes } from "./archive-decode.js";
import { SESSION_ARCHIVE_ZSTD_SUFFIX } from "./transcript-file-names.js";
export { SESSION_ARCHIVE_ZSTD_SUFFIX } from "./transcript-file-names.js";

const zstdCodec = resolveZstdCodec();

export function encodeSessionArchiveContent(content: string): {
  bytes: Buffer;
  suffix: "" | typeof SESSION_ARCHIVE_ZSTD_SUFFIX;
} {
  const plain = Buffer.from(content, "utf8");
  if (!zstdCodec || plain.length === 0) {
    return { bytes: plain, suffix: "" };
  }
  // Default zstd level (3) matches the ratio/speed point Codex uses for cold
  // rollouts; archives are write-once so speed matters less than footprint.
  return { bytes: zstdCodec.compress(plain), suffix: SESSION_ARCHIVE_ZSTD_SUFFIX };
}

/** Full-content convenience read; known source bytes override its bounded default. */
export function readSessionArchiveContentSync(
  filePath: string,
  expectedUtf8Bytes?: number,
): string {
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    return fs.readFileSync(filePath, "utf8");
  }
  if (!zstdCodec) {
    throw new Error(
      `Cannot read compressed transcript archive ${filePath}: this runtime lacks node:zlib zstd support`,
    );
  }
  try {
    return decodeSessionArchiveBytes(fs.readFileSync(filePath), true, expectedUtf8Bytes);
  } catch (error) {
    if (error instanceof Error && hasErrnoCode(error, "ERR_BUFFER_TOO_LARGE")) {
      error.message = "Transcript archive " + filePath + " exceeds its decompression limit";
    }
    throw error;
  }
}

/**
 * Materializes a compressed archive as a plain JSONL cache file and returns
 * the readable path; plain archives pass through untouched. Source identity
 * validates cached bytes so downstream readers need not handle compression.
 */
export async function materializeSessionArchiveForRead(filePath: string): Promise<string> {
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    return filePath;
  }
  const cacheDir = path.join(resolvePreferredOpenClawTmpDir(), "session-archive-read-cache");
  const pathKey = createHash("sha256").update(filePath).digest("hex").slice(0, 32);
  // Source identity gates every hit: a deleted or replaced archive must never
  // keep serving plaintext from the cache (budget eviction deletes archives).
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.statSync(filePath);
  } catch (error) {
    removeMaterializedArchiveCacheEntries(cacheDir, pathKey);
    throw error;
  }
  const cachePath = path.join(
    cacheDir,
    `${pathKey}-${sourceStat.size}-${Math.trunc(sourceStat.mtimeMs)}.jsonl`,
  );
  sweepMaterializedArchiveCache(cacheDir);
  if (fs.existsSync(cachePath)) {
    return cachePath;
  }
  if (!zstdCodec) {
    throw new Error(
      "Cannot materialize compressed transcript archive: this runtime lacks zstd support",
    );
  }
  removeMaterializedArchiveCacheEntries(cacheDir, pathKey, path.basename(cachePath));
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Bound resident input/output buffers, not total expansion: repetitive valid
    // transcripts can be much larger than their compressed archive.
    await pipeline(
      fs.createReadStream(filePath, { highWaterMark: 64 * 1024 }),
      createZstdDecompress({ chunkSize: 64 * 1024 }),
      fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600, highWaterMark: 64 * 1024 }),
    );
    const currentStat = fs.statSync(filePath);
    if (currentStat.size !== sourceStat.size || currentStat.mtimeMs !== sourceStat.mtimeMs) {
      throw new Error("Transcript archive changed during materialization; retry the read");
    }
    // Concurrent readers publish complete files only.
    fs.renameSync(tempPath, cachePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return cachePath;
}

// Bounded plaintext exposure: cache entries expire on age so archives deleted
// by budget eviction cannot leave decompressed copies behind indefinitely,
// and the cache itself cannot outgrow the archives it mirrors for long.
const MATERIALIZED_ARCHIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let lastMaterializedArchiveCacheSweepMs = 0;

function sweepMaterializedArchiveCache(cacheDir: string): void {
  const now = Date.now();
  if (now - lastMaterializedArchiveCacheSweepMs < MATERIALIZED_ARCHIVE_CACHE_TTL_MS / 24) {
    return;
  }
  lastMaterializedArchiveCacheSweepMs = now;
  for (const entry of walkDirectorySync(cacheDir, { maxDepth: 1, symlinks: "include" }).entries) {
    try {
      if (now - fs.statSync(entry.path).mtimeMs > MATERIALIZED_ARCHIVE_CACHE_TTL_MS) {
        fs.rmSync(entry.path, { force: true });
      }
    } catch {
      // Another sweep may have removed it first; nothing to do.
    }
  }
}

// Scrubs stale identities for one archive path while leaving the current
// identity and any in-flight temp files (unique per writer) untouched, so
// concurrent readers can never delete each other's live materialization.
function removeMaterializedArchiveCacheEntries(
  cacheDir: string,
  pathKey: string,
  keepName?: string,
): void {
  for (const entry of walkDirectorySync(cacheDir, { maxDepth: 1, symlinks: "include" }).entries) {
    if (
      !entry.name.startsWith(`${pathKey}-`) ||
      entry.name === keepName ||
      entry.name.endsWith(".tmp")
    ) {
      continue;
    }
    fs.rmSync(entry.path, { force: true });
  }
}
