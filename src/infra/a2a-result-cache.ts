/**
 * A2A Result Cache - Stores skill invocation results keyed by correlationId
 *
 * Solves the concurrent caller race condition by storing results with their
 * correlation IDs, enabling run-scoped retrieval instead of "last message wins".
 *
 * RFC-A2A-RESPONSE-ROUTING: Bounded storage with TTL cleanup.
 */

/**
 * A2A Error Codes - Typed error identifiers for A2A operations
 */
export enum A2AErrorCode {
  NOT_ENABLED = "A2A_NOT_ENABLED",
  AGENT_NOT_ALLOWED = "A2A_AGENT_NOT_ALLOWED",
  SELF_CALL_BLOCKED = "A2A_SELF_CALL_BLOCKED",
  CACHE_MISS = "A2A_CACHE_MISS",
  CACHE_TIMEOUT = "A2A_CACHE_TIMEOUT",
  AGENT_ERROR = "A2A_AGENT_ERROR",
  EMPTY_RESPONSE = "A2A_EMPTY_RESPONSE",
  INVALID_INPUT = "A2A_INVALID_INPUT",
  SESSION_NOT_FOUND = "A2A_SESSION_NOT_FOUND",
}

/**
 * Creates a typed A2A error with code
 */
export class A2AError extends Error {
  constructor(
    public readonly code: A2AErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "A2AError";
  }

  static notEnabled(): A2AError {
    return new A2AError(A2AErrorCode.NOT_ENABLED, "A2A is not enabled in configuration");
  }

  static agentNotAllowed(agent: string): A2AError {
    return new A2AError(A2AErrorCode.AGENT_NOT_ALLOWED, `Agent '${agent}' is not in allowlist`);
  }

  static selfCallBlocked(): A2AError {
    return new A2AError(
      A2AErrorCode.SELF_CALL_BLOCKED,
      "Self-call not allowed - prevents infinite loops",
    );
  }

  static cacheMiss(correlationId: string): A2AError {
    return new A2AError(
      A2AErrorCode.CACHE_MISS,
      `No cached result for correlationId '${correlationId}'`,
    );
  }

  static emptyResponse(): A2AError {
    return new A2AError(A2AErrorCode.EMPTY_RESPONSE, "Agent returned empty or invalid response");
  }
}

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
 * Tracks metrics for hit/miss rate monitoring.
 */
export function getA2AResult(correlationId: string): A2AResult | null {
  const normalizedId = correlationId.trim();
  if (!normalizedId) {
    metrics.misses++;
    return null;
  }

  const entry = resultCache.get(normalizedId);
  if (!entry) {
    metrics.misses++;
    return null;
  }

  // Check expiration
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(normalizedId);
    metrics.misses++;
    metrics.expirations++;
    return null;
  }

  metrics.hits++;
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

  metrics.evictions += toEvict;
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

// ============================================================================
// Metrics Tracking
// ============================================================================

interface A2ACacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  lastResetAt: number;
}

const metrics: A2ACacheMetrics = {
  hits: 0,
  misses: 0,
  evictions: 0,
  expirations: 0,
  lastResetAt: Date.now(),
};

/**
 * Get cache metrics for monitoring and health status.
 */
export function getA2ACacheMetrics(): {
  size: number;
  maxSize: number;
  hitRate: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  oldestEntry?: number;
  newestEntry?: number;
  uptimeMs: number;
} {
  const stats = getA2AResultCacheStats();
  const totalRequests = metrics.hits + metrics.misses;
  const hitRate = totalRequests > 0 ? metrics.hits / totalRequests : 0;

  return {
    size: stats.size,
    maxSize: stats.maxSize,
    hitRate,
    hits: metrics.hits,
    misses: metrics.misses,
    evictions: metrics.evictions,
    expirations: metrics.expirations,
    oldestEntry: stats.oldestEntry,
    newestEntry: stats.newestEntry,
    uptimeMs: Date.now() - metrics.lastResetAt,
  };
}

/**
 * Reset metrics (for testing or periodic reporting).
 */
export function resetA2ACacheMetrics(): void {
  metrics.hits = 0;
  metrics.misses = 0;
  metrics.evictions = 0;
  metrics.expirations = 0;
  metrics.lastResetAt = Date.now();
}
