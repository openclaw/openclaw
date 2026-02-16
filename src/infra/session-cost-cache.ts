import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Persistent cache for session-level cost aggregation results.
 * Stores cached totals per session file based on modification time.
 * When a file's mtime matches cached value, we can reuse the cached totals.
 */

export type SessionCostCacheEntry = {
  lastModified: number;
  cachedTotals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    totalCost: number;
    missingCostEntries: number;
    estimatedCostAmount?: number;
    estimationAccuracy?: {
      realCostCount: number;
      estimatedCount: number;
      totalDeviation: number;
    };
  };
  timestamp: number;
};

export type SessionCostAggregationCache = {
  version: 1;
  sessions: Record<string, SessionCostCacheEntry>;
};

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let cachePath: string | null = null;

export function initSessionCostCache(baseDir: string): void {
  cachePath = path.join(baseDir, ".openclaw/cache/session-cost-cache.json");
}

export async function loadSessionAggregationCache(): Promise<SessionCostAggregationCache> {
  if (!cachePath) {
    return { version: CACHE_VERSION, sessions: {} };
  }

  try {
    const data = await fs.readFile(cachePath, "utf-8");
    const cache: SessionCostAggregationCache = JSON.parse(data);

    // Validate and filter old entries
    if (cache.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, sessions: {} };
    }

    const now = Date.now();
    const filtered: Record<string, SessionCostCacheEntry> = {};

    for (const [key, entry] of Object.entries(cache.sessions)) {
      if (now - entry.timestamp < CACHE_MAX_AGE_MS) {
        filtered[key] = entry;
      }
    }

    return { version: CACHE_VERSION, sessions: filtered };
  } catch {
    return { version: CACHE_VERSION, sessions: {} };
  }
}

export async function saveSessionAggregationCache(
  cache: SessionCostAggregationCache,
): Promise<void> {
  if (!cachePath) {
    return;
  }

  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error(`Failed to save session cost cache: ${String(err)}`);
  }
}

export function getCachedSessionCost(
  cache: SessionCostAggregationCache,
  filePath: string,
  currentMtime: number,
): SessionCostCacheEntry | null {
  const entry = cache.sessions[filePath];

  if (!entry) {
    return null;
  }

  // Validate that file hasn't been modified since cache was created
  if (entry.lastModified !== currentMtime) {
    return null;
  }

  return entry;
}

export function updateSessionCostCache(
  cache: SessionCostAggregationCache,
  filePath: string,
  mtime: number,
  cachedTotals: SessionCostCacheEntry["cachedTotals"],
): void {
  cache.sessions[filePath] = {
    lastModified: mtime,
    cachedTotals,
    timestamp: Date.now(),
  };
}
