/**
 * Process-scoped cache for `fs.existsSync` calls.
 *
 * Plugin manifest discovery calls `fs.existsSync` dozens of times across hot
 * paths during cold start. This module caches results for the lifetime of the
 * Node process, reducing redundant syscalls when the same paths are checked
 * repeatedly within a single scan pass.
 *
 * Call `invalidateExistsSyncCache()` when the underlying filesystem state may
 * have changed (e.g. after installing a plugin).
 */
import fs from "node:fs";

const cache = new Map<string, boolean>();

/**
 * Cached `fs.existsSync`. Returns the same result as `fs.existsSync(p)` but
 * stores it in a process-level `Map` so repeated checks for the same absolute
 * path avoid a syscall.
 */
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
 * Invalidates the cached result for a specific path, or clears the entire
 * cache when called with no argument.
 */
export function invalidateExistsSyncCache(p?: string): void {
  if (p !== undefined) {
    cache.delete(p);
  } else {
    cache.clear();
  }
}
