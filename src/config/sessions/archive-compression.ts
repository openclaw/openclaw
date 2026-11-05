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
  sweepMaterializedArchiveCache(cacheDir);
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
