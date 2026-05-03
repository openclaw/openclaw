import fs from "node:fs";

/**
 * Process-level memoization for `fs.existsSync` checks performed during
 * plugin discovery and other hot startup paths.
 *
 * `fs.existsSync` is synchronous and shows up as a top contributor in CPU
 * profiles of cold starts (see https://github.com/openclaw/openclaw/issues/76209).
 * The plugin scan phase repeatedly probes the same paths (e.g.
 * `<rootDir>/skills`, `<rootDir>/.cursor/rules`) across many manifest
 * resolvers, so caching the result is safe — the directory tree is stable
 * for the duration of the scan.
 *
 * The cache is intentionally never invalidated automatically. Callers that
 * mutate paths and want the next probe to hit the disk should call
 * `invalidateExistsSyncCache()` explicitly. Tests should reset the cache
 * between runs that mutate the filesystem.
 */
const cache = new Map<string, boolean>();

export function existsSyncCached(p: string): boolean {
  const cached = cache.get(p);
  if (cached !== undefined) {
    return cached;
  }
  const result = fs.existsSync(p);
  cache.set(p, result);
  return result;
}

/**
 * Drop a single cached entry, or the entire cache when `p` is omitted.
 */
export function invalidateExistsSyncCache(p?: string): void {
  if (p === undefined) {
    cache.clear();
    return;
  }
  cache.delete(p);
}
