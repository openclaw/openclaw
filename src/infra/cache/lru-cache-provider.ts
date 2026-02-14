/**
 * LRU (Least Recently Used) cache provider with size-based eviction
 */

import type { CacheEntry, CacheOptions, CacheProvider, CacheStats } from "./cache-types.js";

export class LRUCacheProvider implements CacheProvider {
  private cache = new Map<string, CacheEntry>();
  private accessOrder: string[] = [];
  private statistics: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    size: 0,
    maxSize: 0,
    entries: 0,
    hitRate: 0,
    avgLatency: 0,
  };

  private latencies: number[] = [];
  private readonly maxLatencyRecords = 1000;

  constructor(
    private readonly maxSizeInBytes: number = 100 * 1024 * 1024, // 100MB default
    private readonly defaultTTL: number = 900, // 15 minutes default
  ) {
    this.statistics.maxSize = maxSizeInBytes;
  }

  async get<T>(key: string): Promise<T | null> {
    const startTime = performance.now();
    const entry = this.cache.get(key);

    if (!entry) {
      this.statistics.misses++;
      this.recordLatency(performance.now() - startTime);
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      this.statistics.size -= entry.size;
      this.statistics.entries--;
      this.statistics.misses++;
      this.recordLatency(performance.now() - startTime);
      return null;
    }

    // Update access tracking
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    this.updateAccessOrder(key);

    this.statistics.hits++;
    this.updateHitRate();
    this.recordLatency(performance.now() - startTime);

    return entry.value as T;
  }

  async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    const startTime = performance.now();
    const ttl = options?.ttl ?? this.defaultTTL;
    const size = this.estimateSize(value);

    // Check if we need to evict entries to make room
    await this.evictIfNeeded(size);

    const entry: CacheEntry<T> = {
      value,
      key,
      size,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
      accessCount: 0,
      lastAccessedAt: Date.now(),
      metadata: options ? { tags: options.tags, priority: options.priority } : undefined,
    };

    // If key exists, update size tracking
    const existing = this.cache.get(key);
    if (existing) {
      this.statistics.size -= existing.size;
    } else {
      this.statistics.entries++;
    }

    this.cache.set(key, entry);
    this.statistics.size += size;
    this.updateAccessOrder(key);

    this.recordLatency(performance.now() - startTime);
  }

  async delete(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    this.cache.delete(key);
    this.removeFromAccessOrder(key);
    this.statistics.size -= entry.size;
    this.statistics.entries--;
    return true;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.accessOrder = [];
    this.statistics.size = 0;
    this.statistics.entries = 0;
    this.statistics.evictions = 0;
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      await this.delete(key);
      return false;
    }

    return true;
  }

  async size(): Promise<number> {
    return this.statistics.size;
  }

  async stats(): Promise<CacheStats> {
    return { ...this.statistics };
  }

  private async evictIfNeeded(requiredSize: number): Promise<void> {
    while (
      this.statistics.size + requiredSize > this.statistics.maxSize &&
      this.accessOrder.length > 0
    ) {
      // Evict least recently used
      const keyToEvict = this.accessOrder[0];
      if (keyToEvict) {
        const entry = this.cache.get(keyToEvict);
        if (entry) {
          this.cache.delete(keyToEvict);
          this.accessOrder.shift();
          this.statistics.size -= entry.size;
          this.statistics.entries--;
          this.statistics.evictions++;
        }
      }
    }
  }

  private updateAccessOrder(key: string): void {
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  private estimateSize(value: unknown): number {
    // Rough estimation of object size in bytes
    if (typeof value === "string") {
      return value.length * 2; // UTF-16
    }

    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 1024; // Default 1KB for non-serializable objects
    }
  }

  private updateHitRate(): void {
    const total = this.statistics.hits + this.statistics.misses;
    if (total > 0) {
      this.statistics.hitRate = (this.statistics.hits / total) * 100;
    }
  }

  private recordLatency(latencyMs: number): void {
    this.latencies.push(latencyMs);
    if (this.latencies.length > this.maxLatencyRecords) {
      this.latencies.shift();
    }

    // Update average latency
    if (this.latencies.length > 0) {
      const sum = this.latencies.reduce((a, b) => a + b, 0);
      this.statistics.avgLatency = sum / this.latencies.length;
    }
  }

  /**
   * Get entries by tag
   */
  async getByTag(tag: string): Promise<Array<{ key: string; value: unknown }>> {
    const results: Array<{ key: string; value: unknown }> = [];

    for (const [key, entry] of this.cache.entries()) {
      const tags = entry.metadata?.tags as string[] | undefined;
      if (tags?.includes(tag) && Date.now() <= entry.expiresAt) {
        results.push({ key, value: entry.value });
      }
    }

    return results;
  }

  /**
   * Invalidate entries by tag
   */
  async invalidateByTag(tag: string): Promise<number> {
    let invalidated = 0;
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      const tags = entry.metadata?.tags as string[] | undefined;
      if (tags?.includes(tag)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      if (await this.delete(key)) {
        invalidated++;
      }
    }

    return invalidated;
  }
}
