/**
 * A2A Result Cache - Stores skill invocation results keyed by correlationId
 *
 * Solves the concurrent caller race condition by storing results with their
 * correlation IDs, enabling run-scoped retrieval instead of "last message wins".
 *
 * RFC-A2A-RESPONSE-ROUTING: Bounded storage with TTL cleanup.
 */

export interface A2AResult {
  status: "completed" | "error" | "timeout";
  output?: unknown;
  confidence?: number;
  assumptions?: string[];
  caveats?: string[];
  error?: string;
  correlationId: string;
  targetSessionKey: string;
  returnToSessionKey?: string;
  requesterSessionKey?: string;
  skill: string;
  createdAt: number;
  completedAt: number;
}

interface CacheEntry {
  result: A2AResult;
  expiresAt: number;
}

// In-memory cache with TTL
const resultCache = new Map<string, CacheEntry>();

// Configuration
const DEFAULT_TTL_MS = 60_000; // 1 minute
const MAX_TTL_MS = 3_600_000; // 1 hour
const MAX_CACHE_SIZE = 10_000; // Max entries before eviction

// Cleanup interval (runs every 30 seconds)
let cleanupInterval: NodeJS.Timeout | undefined;

/**
 * Store a result in the cache.
 * Returns true if stored, false if cache is full.
 */
export function storeA2AResult(
  correlationId: string,
  result: Omit<A2AResult, "createdAt" | "completedAt">,
  ttlMs?: number,
): boolean {
  const normalizedId = correlationId.trim();
  if (!normalizedId) {
    return false;
  }

  // Enforce max cache size with LRU eviction
  if (resultCache.size >= MAX_CACHE_SIZE) {
    evictOldest();
  }

  const effectiveTtl = Math.min(Math.max(1, ttlMs ?? DEFAULT_TTL_MS), MAX_TTL_MS);

  const now = Date.now();
  const entry: CacheEntry = {
    result: {
      ...result,
      createdAt: now,
      completedAt: now,
    },
    expiresAt: now + effectiveTtl,
  };

  resultCache.set(normalizedId, entry);
  return true;
}

/**
 * Retrieve a result from the cache.
 * Returns null if not found or expired.
 */
export function getA2AResult(correlationId: string): A2AResult | null {
  const normalizedId = correlationId.trim();
  if (!normalizedId) {
    return null;
  }

  const entry = resultCache.get(normalizedId);
  if (!entry) {
    return null;
  }

  // Check expiration
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(normalizedId);
    return null;
  }

  return entry.result;
}

/**
 * Remove a result from the cache.
 */
export function deleteA2AResult(correlationId: string): boolean {
  const normalizedId = correlationId.trim();
  if (!normalizedId) {
    return false;
  }
  return resultCache.delete(normalizedId);
}

/**
 * Check if a result exists and is not expired.
 */
export function hasA2AResult(correlationId: string): boolean {
  return getA2AResult(correlationId) !== null;
}

/**
 * Get cache statistics.
 */
export function getA2AResultCacheStats(): {
  size: number;
  maxSize: number;
  oldestEntry?: number;
  newestEntry?: number;
} {
  let oldest: number | undefined;
  let newest: number | undefined;

  for (const entry of resultCache.values()) {
    const createdAt = entry.result.createdAt;
    if (oldest === undefined || createdAt < oldest) {
      oldest = createdAt;
    }
    if (newest === undefined || createdAt > newest) {
      newest = createdAt;
    }
  }

  return {
    size: resultCache.size,
    maxSize: MAX_CACHE_SIZE,
    oldestEntry: oldest,
    newestEntry: newest,
  };
}

/**
 * Clear all expired entries.
 * Returns number of entries evicted.
 */
export function cleanupExpiredResults(): number {
  const now = Date.now();
  let evicted = 0;

  for (const [id, entry] of resultCache.entries()) {
    if (now > entry.expiresAt) {
      resultCache.delete(id);
      evicted++;
    }
  }

  return evicted;
}

/**
 * Evict oldest 10% of entries when cache is full.
 */
function evictOldest(): void {
  const toEvict = Math.ceil(MAX_CACHE_SIZE * 0.1);
  const entries = Array.from(resultCache.entries()).toSorted(
    (a, b) => a[1].result.createdAt - b[1].result.createdAt,
  );

  for (let i = 0; i < Math.min(toEvict, entries.length); i++) {
    const [id] = entries[i];
    resultCache.delete(id);
  }
}

/**
 * Clear the entire cache.
 */
export function clearA2AResultCache(): void {
  resultCache.clear();
}

/**
 * Start periodic cleanup.
 * Should be called once at gateway startup.
 */
export function startA2AResultCacheCleanup(intervalMs = 30_000): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }
  cleanupInterval = setInterval(() => {
    cleanupExpiredResults();
  }, intervalMs);
  cleanupInterval.unref?.();
}

/**
 * Stop periodic cleanup.
 */
export function stopA2AResultCacheCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
  }
}

/**
 * Test-only: Reset cache state.
 */
export function resetA2AResultCacheForTest(): void {
  resultCache.clear();
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
  }
}

export const __testing = {
  getCacheSize: () => resultCache.size,
  getMaxCacheSize: () => MAX_CACHE_SIZE,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
};
