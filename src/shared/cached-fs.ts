/** Process-scoped cache for fs.existsSync to reduce syscall overhead. */
import fs from "node:fs";

const existsSyncCache = new Map<string, boolean>();

export function existsSyncCached(p: string): boolean {
  const cached = existsSyncCache.get(p);
  if (cached !== undefined) {
    return cached;
  }
  const result = fs.existsSync(p);
  existsSyncCache.set(p, result);
  return result;
}

export function invalidateExistsSyncCache(p?: string): void {
  if (p) {
    existsSyncCache.delete(p);
  } else {
    existsSyncCache.clear();
  }
}
