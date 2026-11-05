// Budget for the plaintext session-archive read cache. Every entry is a
// decompressed copy of an archive, so an unbounded cache can fill a small
// tmpfs on its own; entries are evicted least-recently-used first.
import fs from "node:fs";
import path from "node:path";

/** Total plaintext bytes the materialized archive read cache may keep. */
export const MATERIALIZED_ARCHIVE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
/** Entry cap, so a long tail of small archives cannot defeat the byte budget. */
export const MATERIALIZED_ARCHIVE_CACHE_MAX_ENTRIES = 64;

export type MaterializedArchiveCacheBudget = {
  maxBytes?: number;
  maxEntries?: number;
};

type CacheEntry = { path: string; mtimeMs: number; size: number };

function readCacheEntries(cacheDir: string): CacheEntry[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: CacheEntry[] = [];
  for (const dirent of dirents) {
    // In-flight writers use unique `.tmp` names; never evict those.
    if (!dirent.isFile() || dirent.name.endsWith(".tmp")) {
      continue;
    }
    try {
      const entryPath = path.join(cacheDir, dirent.name);
      const stat = fs.statSync(entryPath);
      entries.push({ path: entryPath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Another sweep may have removed it first; nothing to do.
    }
  }
  return entries;
}

/**
 * Evicts least-recently-used cache entries until the directory fits its
 * budget. Cache hits refresh an entry's mtime, so "recently used" is what
 * survives. Deleting a file another reader has open is safe on POSIX; on
 * platforms where it is not, the removal throws and the entry is retried on
 * the next pass.
 */
export function evictMaterializedArchiveCacheOverBudget(
  cacheDir: string,
  budget: MaterializedArchiveCacheBudget = {},
): void {
  const maxBytes = budget.maxBytes ?? MATERIALIZED_ARCHIVE_CACHE_MAX_BYTES;
  const maxEntries = budget.maxEntries ?? MATERIALIZED_ARCHIVE_CACHE_MAX_ENTRIES;
  const entries = readCacheEntries(cacheDir);
  let bytes = entries.reduce((total, entry) => total + entry.size, 0);
  let count = entries.length;
  if (bytes <= maxBytes && count <= maxEntries) {
    return;
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of entries) {
    if (bytes <= maxBytes && count <= maxEntries) {
      break;
    }
    try {
      fs.rmSync(entry.path, { force: true });
      bytes -= entry.size;
      count -= 1;
    } catch {
      // Concurrent reader or a platform that refuses unlinking an open file.
    }
  }
}
