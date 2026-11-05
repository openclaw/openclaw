// Zstd compression for archived transcript artifacts (Codex-style cold tier).
// Archives are kept long-term by default, so compressing them is what keeps
// "never delete conversations" cheap: JSONL transcripts compress ~10:1.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline as pipelineStreams, type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { walkDirectorySync } from "@openclaw/fs-safe/walk";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { materializedArchiveCacheBudgetBytes } from "./archive-cache-budget.js";
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

// Only the publishing writer knows a trusted plaintext size; it verifies its own
// output in memory. Every other reader streams through materializeSessionArchiveForRead.
export function readSessionArchiveContentSync(filePath: string, expectedBytes: number): string {
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    return fs.readFileSync(filePath, "utf8");
  }
  return zstdCodec.decompress(fs.readFileSync(filePath), expectedBytes).toString("utf8");
}

// Streaming bounds memory to one chunk regardless of expansion, so frame-declared
// sizes and compression ratios (p99 34x, max 114x in production) are never trusted.
// This ceiling only bounds the disk a corrupt or crafted frame can fill in the
// cache; valid archives are capped far lower by the writer's in-memory string.
const MATERIALIZED_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** True when an archive's own bytes cannot be decoded; retrying the same file cannot succeed. */
export function isSessionArchiveDecodeError(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return (
    typeof code === "string" &&
    (code === "ERR_BUFFER_TOO_LARGE" || code === "Z_BUF_ERROR" || code.startsWith("ZSTD_error_"))
  );
}

function limitDecodedBytes(filePath: string): Transform {
  let decoded = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      decoded += chunk.length;
      if (decoded > MATERIALIZED_ARCHIVE_MAX_BYTES) {
        const error = new RangeError(
          `Session archive ${filePath} expands past the ${MATERIALIZED_ARCHIVE_MAX_BYTES}-byte read budget; the archive is unchanged. Move it out of the sessions directory to stop reading it, or decompress it elsewhere with zstd to inspect it.`,
        );
        callback(Object.assign(error, { code: "ERR_BUFFER_TOO_LARGE" }));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Decodes a compressed archive as a stream without a cache file; any read or
 * decode error is delivered through the returned stream.
 */
export function openSessionArchiveDecodedStream(filePath: string): Readable {
  return pipelineStreams(
    fs.createReadStream(filePath),
    zlib.createZstdDecompress(),
    limitDecodedBytes(filePath),
    () => undefined,
  );
}

/** Every reader identity of one compressed archive path starts with this prefix. */
export function resolveSessionArchiveReadPathPrefix(filePath: string, cacheDir?: string): string {
  const pathKey = createHash("sha256").update(filePath).digest("hex").slice(0, 32);
  return path.join(
    cacheDir ?? path.join(resolvePreferredOpenClawTmpDir(), "session-archive-read-cache"),
    `${pathKey}-`,
  );
}

/** Resolve the reader identity from source metadata without expanding archive bytes. */
export function resolveSessionArchiveReadPath(
  filePath: string,
  sourceStat: Pick<fs.Stats, "size" | "mtimeMs">,
  cacheDir?: string,
): string {
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    return filePath;
  }
  return `${resolveSessionArchiveReadPathPrefix(filePath, cacheDir)}${sourceStat.size}-${Math.trunc(sourceStat.mtimeMs)}.jsonl`;
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
  const cachePath = resolveSessionArchiveReadPath(filePath, sourceStat, cacheDir);
  // Age cleanup stays reachable on hits; the caller reads archives it already
  // has, so relying on the write path alone would leave expired entries forever.
  // The entry being returned is exempt so the read never targets an evicted file.
  sweepMaterializedArchiveCache(cacheDir, path.basename(cachePath));
  if (fs.existsSync(cachePath)) {
    return cachePath;
  }
  removeMaterializedArchiveCacheEntries(cacheDir, pathKey, path.basename(cachePath));
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await pipeline(
      openSessionArchiveDecodedStream(filePath),
      fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  // Concurrent readers may race to the same identity; last rename wins with
  // identical content, so neither can observe a torn or missing cache file.
  fs.renameSync(tempPath, cachePath);
  // Charge the entry just published against the aggregate budget. Eviction never
  // removes `cachePath`: an archive larger than the whole budget must still be
  // readable on this call, so it is retained and the other entries make room.
  enforceMaterializedArchiveCacheBudget(cacheDir, path.basename(cachePath));
  return cachePath;
}

// Bounded plaintext exposure: cache entries expire on age so archives deleted
// by budget eviction cannot leave decompressed copies behind indefinitely,
// and the cache itself cannot outgrow the archives it mirrors for long.
const MATERIALIZED_ARCHIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let lastMaterializedArchiveCacheSweepMs = 0;

// Aggregate ceiling for the cache directory. Per-entry TTL alone still lets a
// busy gateway materialize every archive it touches within a day, which is how
// /tmp filled with hundreds of decompressed copies (#193193). The budget bounds
// total retained plaintext and evicts least-recently-materialized entries first.

function sweepMaterializedArchiveCache(cacheDir: string, keepName?: string): void {
  // An absent cache directory has nothing to reclaim; consuming the sweep slot
  // here would rate-limit away the first pass that actually has entries.
  if (!fs.existsSync(cacheDir)) {
    return;
  }
  const now = Date.now();
  // The TTL sweep is rate limited because expired entries stay cold until the
  // next pass; the aggregate budget is checked on every call, since the
  // materialization that just published is exactly what can push it over.
  if (now - lastMaterializedArchiveCacheSweepMs >= MATERIALIZED_ARCHIVE_CACHE_TTL_MS / 24) {
    lastMaterializedArchiveCacheSweepMs = now;
    for (const entry of walkDirectorySync(cacheDir, { maxDepth: 1, symlinks: "include" }).entries) {
      try {
        if (
          now - fs.statSync(entry.path).mtimeMs > MATERIALIZED_ARCHIVE_CACHE_TTL_MS &&
          entry.name !== keepName
        ) {
          fs.rmSync(entry.path, { force: true });
        }
      } catch {
        // Another sweep may have removed it first; nothing to do.
      }
    }
  }
  enforceMaterializedArchiveCacheBudget(cacheDir, keepName);
}

// Evicts least-recently-materialized entries until retained cache bytes fit the
// aggregate budget. Source identity still gates every hit, so an evicted entry
// only costs a re-decode, never a wrong read.
// `keepName` is the entry the current call is about to read: an archive larger
// than the whole budget would otherwise evict its own fresh materialization and
// return a path that no longer exists.
function enforceMaterializedArchiveCacheBudget(cacheDir: string, keepName?: string): void {
  const retained: { path: string; size: number; mtimeMs: number }[] = [];
  for (const entry of walkDirectorySync(cacheDir, { maxDepth: 1, symlinks: "include" }).entries) {
    try {
      // In-flight temp files belong to a concurrent writer; they are charged
      // once renamed into place.
      if (entry.name.endsWith(".tmp")) {
        continue;
      }
      const stat = fs.statSync(entry.path);
      retained.push({ path: entry.path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Another sweep may have removed it first; nothing to do.
    }
  }
  let totalBytes = retained.reduce((sum, entry) => sum + entry.size, 0);
  const budgetBytes = materializedArchiveCacheBudgetBytes;
  if (totalBytes <= budgetBytes) {
    return;
  }
  // Oldest materialization first, so recently read sessions keep a warm cache.
  retained.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of retained) {
    if (totalBytes <= budgetBytes) {
      break;
    }
    // The entry this call just materialized stays readable even when it alone
    // exceeds the budget; every other entry makes room first.
    if (keepName !== undefined && path.basename(entry.path) === keepName) {
      continue;
    }
    try {
      fs.rmSync(entry.path, { force: true });
      totalBytes -= entry.size;
    } catch {
      // Removal is best effort: a live reader may hold the file on some
      // filesystems. The next call retries the remaining overage.
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
