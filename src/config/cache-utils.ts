import fs from "node:fs";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";

export function resolveCacheTtlMs(params: {
  envValue: string | undefined;
  defaultTtlMs: number;
}): number {
  const { envValue, defaultTtlMs } = params;
  if (envValue) {
    const parsed = parseStrictNonNegativeInteger(envValue);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return defaultTtlMs;
}

export function isCacheEnabled(ttlMs: number): boolean {
  return ttlMs > 0;
}

export type FileStatSnapshot = {
  mtimeMs: number;
  sizeBytes: number;
};

type StatCacheEntry = {
  snapshot: FileStatSnapshot;
  timestamp: number;
};

const STAT_CACHE = new Map<string, StatCacheEntry>();
const STAT_CACHE_TTL_MS = 100;

export function getFileStatSnapshot(filePath: string): FileStatSnapshot | undefined {
  const now = Date.now();
  const cached = STAT_CACHE.get(filePath);
  if (cached && now - cached.timestamp < STAT_CACHE_TTL_MS) {
    return cached.snapshot;
  }
  try {
    const stats = fs.statSync(filePath);
    const snapshot: FileStatSnapshot = {
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
    };
    STAT_CACHE.set(filePath, { snapshot, timestamp: now });
    return snapshot;
  } catch {
    STAT_CACHE.delete(filePath);
    return undefined;
  }
}

export function clearFileStatSnapshotCacheForTest(): void {
  STAT_CACHE.clear();
}
