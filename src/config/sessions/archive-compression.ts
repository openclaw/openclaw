// Zstd compression for archived transcript artifacts (Codex-style cold tier).
// Archives are kept long-term by default, so compressing them is what keeps
// "never delete conversations" cheap: JSONL transcripts compress ~10:1.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { walkDirectorySync } from "@openclaw/fs-safe/walk";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import {
  MAX_SESSION_ARCHIVE_STREAM_BYTES,
  SessionArchivePlaintextLimitError,
} from "./archive-limits.js";
import { SESSION_ARCHIVE_ZSTD_SUFFIX } from "./transcript-file-names.js";
export { SESSION_ARCHIVE_ZSTD_SUFFIX } from "./transcript-file-names.js";

const zstdCodec = resolveZstdCodec();

export function encodeSessionArchiveContent(content: string): {
  bytes: Buffer;
  suffix: "" | typeof SESSION_ARCHIVE_ZSTD_SUFFIX;
} {
  const plain = Buffer.from(content, "utf8");
  if (plain.length === 0) {
    return { bytes: plain, suffix: "" };
  }
  // Default zstd level (3) matches the ratio/speed point Codex uses for cold
  // rollouts; archives are write-once so speed matters less than footprint.
  return { bytes: zstdCodec.compress(plain), suffix: SESSION_ARCHIVE_ZSTD_SUFFIX };
}

export function readSessionArchiveContentSync(filePath: string): string {
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    return fs.readFileSync(filePath, "utf8");
  }
  return zstdCodec.decompress(fs.readFileSync(filePath)).toString("utf8");
}

/**
 * Materializes a compressed archive as a plain JSONL cache file and returns
 * the readable path; plain archives pass through untouched. Source identity
 * validates cached bytes so downstream readers need not handle compression.
 *
 * Decoding streams straight into the cache file, so peak memory stays at one
 * chunk regardless of how far the archive expands. Only the decoded byte count
 * is bounded, and only past the largest plaintext a producer can create. This
 * budget belongs to the stream: the synchronous string reader above keeps its
 * original unchecked behavior, since its result has to fit in memory anyway.
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
  removeMaterializedArchiveCacheEntries(cacheDir, pathKey, path.basename(cachePath));
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await streamArchivePlaintext(filePath, sourceStat.size, tempPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  // Concurrent readers may race to the same identity; last rename wins with
  // identical content, so neither can observe a torn or missing cache file.
  fs.renameSync(tempPath, cachePath);
  return cachePath;
}

async function streamArchivePlaintext(
  archivePath: string,
  storedBytes: number,
  destinationPath: string,
): Promise<void> {
  const decoder = zstdCodec.createDecompressStream();
  let decodedBytes = 0;
  decoder.on("data", (chunk: Buffer) => {
    decodedBytes += chunk.byteLength;
    if (decodedBytes > MAX_SESSION_ARCHIVE_STREAM_BYTES) {
      decoder.destroy(
        new SessionArchivePlaintextLimitError({
          source: archivePath,
          storedBytes,
          limitBytes: MAX_SESSION_ARCHIVE_STREAM_BYTES,
        }),
      );
    }
  });
  await pipeline(
    fs.createReadStream(archivePath),
    decoder,
    fs.createWriteStream(destinationPath, { mode: 0o600 }),
  );
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
