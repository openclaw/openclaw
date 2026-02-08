/**
 * Performance Cache
 * 
 * Caches browser snapshots and other expensive operations to improve performance.
 * Reduces repeated fetches and speeds up browser operations.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("performance-cache");

export type CacheConfig = {
  /** Enable caching */
  enabled: boolean;
  /** Snapshot cache TTL in milliseconds */
  snapshotTtlMs: number;
  /** Maximum cache entries */
  maxEntries: number;
};

export type CachedSnapshot = {
  targetId: string;
  snapshot: any;
  timestamp: number;
  accessCount: number;
};

export const DEFAULT_CONFIG: CacheConfig = {
  enabled: true,
  snapshotTtlMs: 5000, // 5 seconds
  maxEntries: 50,
};

/**
 * Performance Cache
 * 
 * LRU cache for browser snapshots and other expensive operations.
 */
export class PerformanceCache {
  private config: CacheConfig;
  private profileName: string;
  private cache: Map<string, CachedSnapshot>;
  private hitCount = 0;
  private missCount = 0;

  constructor(profileName: string, config: Partial<CacheConfig> = {}) {
    this.profileName = profileName;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new Map();
  }

  /**
   * Get a cached snapshot
   */
  getSnapshot(targetId: string): any | null {
    if (!this.config.enabled) {
      return null;
    }

    const entry = this.cache.get(targetId);
    if (!entry) {
      this.missCount++;
      log.debug(
        `[${this.profileName}] Cache miss: ${targetId} (hit rate: ${this.getHitRate()}%)`
      );
      return null;
    }

    // Check if expired
    const age = Date.now() - entry.timestamp;
    if (age > this.config.snapshotTtlMs) {
      log.debug(
        `[${this.profileName}] Cache expired: ${targetId} (age: ${age}ms)`
      );
      this.cache.delete(targetId);
      this.missCount++;
      return null;
    }

    // Cache hit!
    entry.accessCount++;
    this.hitCount++;
    
    log.debug(
      `[${this.profileName}] Cache hit: ${targetId} (age: ${age}ms, hits: ${entry.accessCount}, hit rate: ${this.getHitRate()}%)`
    );

    return entry.snapshot;
  }

  /**
   * Store a snapshot in cache
   */
  setSnapshot(targetId: string, snapshot: any): void {
    if (!this.config.enabled) {
      return;
    }

    // Prune if at max capacity
    if (this.cache.size >= this.config.maxEntries) {
      this.pruneOldest();
    }

    this.cache.set(targetId, {
      targetId,
      snapshot,
      timestamp: Date.now(),
      accessCount: 0,
    });

    log.debug(
      `[${this.profileName}] Cached snapshot: ${targetId} (cache size: ${this.cache.size})`
    );
  }

  /**
   * Invalidate a cached snapshot
   */
  invalidate(targetId: string): boolean {
    const deleted = this.cache.delete(targetId);
    if (deleted) {
      log.debug(`[${this.profileName}] Invalidated cache: ${targetId}`);
    }
    return deleted;
  }

  /**
   * Invalidate all cached snapshots
   */
  invalidateAll(): number {
    const size = this.cache.size;
    this.cache.clear();
    
    if (size > 0) {
      log.info(
        `[${this.profileName}] Invalidated all cache entries (${size} entries)`
      );
    }
    
    return size;
  }

  /**
   * Prune expired entries
   */
  pruneExpired(): number {
    const now = Date.now();
    const threshold = now - this.config.snapshotTtlMs;
    let pruned = 0;

    for (const [targetId, entry] of this.cache.entries()) {
      if (entry.timestamp < threshold) {
        this.cache.delete(targetId);
        pruned++;
      }
    }

    if (pruned > 0) {
      log.debug(
        `[${this.profileName}] Pruned ${pruned} expired entries (cache size: ${this.cache.size})`
      );
    }

    return pruned;
  }

  /**
   * Prune the oldest entry (LRU)
   */
  private pruneOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [targetId, entry] of this.cache.entries()) {
      // Consider both age and access count (LRU-like)
      const score = entry.timestamp - entry.accessCount * 1000;
      if (score < oldestTime) {
        oldestTime = score;
        oldestKey = targetId;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      log.debug(
        `[${this.profileName}] Pruned oldest entry: ${oldestKey}`
      );
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 
      ? Math.round((this.hitCount / totalRequests) * 100)
      : 0;

    return {
      size: this.cache.size,
      maxEntries: this.config.maxEntries,
      hitCount: this.hitCount,
      missCount: this.missCount,
      totalRequests,
      hitRate,
      enabled: this.config.enabled,
    };
  }

  /**
   * Get cache hit rate percentage
   */
  getHitRate(): number {
    const total = this.hitCount + this.missCount;
    return total > 0 ? Math.round((this.hitCount / total) * 100) : 0;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.hitCount = 0;
    this.missCount = 0;
    log.debug(`[${this.profileName}] Statistics reset`);
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Check if a snapshot is cached
   */
  has(targetId: string): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const entry = this.cache.get(targetId);
    if (!entry) {
      return false;
    }

    // Check if expired
    const age = Date.now() - entry.timestamp;
    if (age > this.config.snapshotTtlMs) {
      this.cache.delete(targetId);
      return false;
    }

    return true;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CacheConfig>): void {
    this.config = { ...this.config, ...config };
    
    if (!this.config.enabled) {
      this.invalidateAll();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<CacheConfig> {
    return { ...this.config };
  }
}

/**
 * Create a performance cache instance
 */
export function createPerformanceCache(
  profileName: string,
  config?: Partial<CacheConfig>
): PerformanceCache {
  return new PerformanceCache(profileName, config);
}

/**
 * Format cache statistics for logging
 */
export function formatCacheStats(stats: ReturnType<PerformanceCache["getStats"]>): string {
  const status = stats.enabled ? "enabled" : "disabled";
  return `Cache ${status}: ${stats.size}/${stats.maxEntries} entries, ${stats.hitRate}% hit rate (${stats.hitCount} hits, ${stats.missCount} misses)`;
}
