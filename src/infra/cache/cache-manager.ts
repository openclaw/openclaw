/**
 * Central cache manager for OpenClaw
 * Handles different resource types with appropriate caching strategies
 */

import crypto from "node:crypto";
import type {
  CacheableResourceType,
  CacheManagerConfig,
  CacheOptions,
  CacheProvider,
  CacheStats,
  ResourceCacheConfig,
} from "./cache-types.js";
import { LRUCacheProvider } from "./lru-cache-provider.js";

// Default configurations for different resource types
const RESOURCE_CONFIGS: Record<CacheableResourceType, Omit<ResourceCacheConfig, "type">> = {
  "web-search": {
    ttl: 900, // 15 minutes
    maxEntries: 100,
    shouldCache: (value) => value != null && typeof value === "object",
  },
  "model-response": {
    ttl: 600, // 10 minutes - shorter as context matters more
    maxEntries: 50,
    shouldCache: (value) => {
      // Don't cache error responses or very short responses
      if (!value || typeof value !== "object") {
        return false;
      }
      const response = value as any;
      const text = response.text || response.content || "";
      return text.length > 50; // Only cache substantial responses
    },
  },
  "tool-result": {
    ttl: 1800, // 30 minutes for deterministic tool results
    maxEntries: 200,
    shouldCache: (value) => value != null,
  },
  "session-context": {
    ttl: 3600, // 1 hour
    maxEntries: 50,
    shouldCache: (value) => value != null,
  },
  embeddings: {
    ttl: 86400, // 24 hours - embeddings rarely change
    maxEntries: 1000,
    shouldCache: (value) => value != null,
  },
  "directory-lookup": {
    ttl: 1800, // 30 minutes
    maxEntries: 100,
    shouldCache: (value) => value != null,
  },
};

export class CacheManager {
  private providers: Map<CacheableResourceType, CacheProvider> = new Map();
  private globalProvider: CacheProvider;
  private config: CacheManagerConfig;
  private metricsInterval?: NodeJS.Timeout;
  private aggregatedStats: Map<CacheableResourceType, CacheStats> = new Map();

  constructor(config?: Partial<CacheManagerConfig>) {
    this.config = {
      provider: "memory",
      maxSizeInMB: 100,
      defaultTTL: 900,
      compressionThreshold: 1024,
      evictionPolicy: "lru",
      enableMetrics: true,
      ...config,
    };

    // Initialize global provider
    const maxBytes = (this.config.maxSizeInMB || 100) * 1024 * 1024;
    this.globalProvider = new LRUCacheProvider(maxBytes, this.config.defaultTTL);

    // Initialize per-resource providers if needed
    this.initializeResourceProviders();

    // Start metrics collection if enabled
    if (this.config.enableMetrics) {
      this.startMetricsCollection();
    }
  }

  private initializeResourceProviders(): void {
    // For now, use the global provider for all resources
    // In future, could have separate providers per resource type
    for (const resourceType of Object.keys(RESOURCE_CONFIGS) as CacheableResourceType[]) {
      this.providers.set(resourceType, this.globalProvider);
    }
  }

  /**
   * Get or set a cached value
   */
  async getOrSet<T>(
    resourceType: CacheableResourceType,
    key: string | Record<string, unknown>,
    fetcher: () => Promise<T>,
    options?: CacheOptions,
  ): Promise<{ value: T; cached: boolean }> {
    const provider = this.providers.get(resourceType) || this.globalProvider;
    const config = RESOURCE_CONFIGS[resourceType];
    const cacheKey = this.generateKey(resourceType, key);

    // Try to get from cache
    const cached = await provider.get<T>(cacheKey);
    if (cached !== null) {
      return { value: cached, cached: true };
    }

    // Fetch new value
    const value = await fetcher();

    // Check if we should cache this value
    if (config.shouldCache && !config.shouldCache(value)) {
      return { value, cached: false };
    }

    // Store in cache
    const ttl = options?.ttl ?? config.ttl;
    await provider.set(cacheKey, value, {
      ...options,
      ttl,
      tags: [...(options?.tags || []), resourceType],
    });

    return { value, cached: false };
  }

  /**
   * Get a cached value directly
   */
  async get<T>(
    resourceType: CacheableResourceType,
    key: string | Record<string, unknown>,
  ): Promise<T | null> {
    const provider = this.providers.get(resourceType) || this.globalProvider;
    const cacheKey = this.generateKey(resourceType, key);
    return provider.get<T>(cacheKey);
  }

  /**
   * Set a value in cache
   */
  async set<T>(
    resourceType: CacheableResourceType,
    key: string | Record<string, unknown>,
    value: T,
    options?: CacheOptions,
  ): Promise<void> {
    const provider = this.providers.get(resourceType) || this.globalProvider;
    const config = RESOURCE_CONFIGS[resourceType];
    const cacheKey = this.generateKey(resourceType, key);

    // Check if we should cache this value
    if (config.shouldCache && !config.shouldCache(value)) {
      return;
    }

    const ttl = options?.ttl ?? config.ttl;
    await provider.set(cacheKey, value, {
      ...options,
      ttl,
      tags: [...(options?.tags || []), resourceType],
    });
  }

  /**
   * Invalidate a specific cache entry
   */
  async invalidate(
    resourceType: CacheableResourceType,
    key: string | Record<string, unknown>,
  ): Promise<boolean> {
    const provider = this.providers.get(resourceType) || this.globalProvider;
    const cacheKey = this.generateKey(resourceType, key);
    return provider.delete(cacheKey);
  }

  /**
   * Invalidate all entries of a specific resource type
   */
  async invalidateResourceType(resourceType: CacheableResourceType): Promise<number> {
    const provider = this.providers.get(resourceType) || this.globalProvider;

    if (provider instanceof LRUCacheProvider) {
      return provider.invalidateByTag(resourceType);
    }

    // Fallback: clear all (not ideal)
    await provider.clear();
    return 0;
  }

  /**
   * Clear all caches
   */
  async clearAll(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.clear();
    }
    await this.globalProvider.clear();
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    global: CacheStats;
    byResource: Map<CacheableResourceType, CacheStats>;
  }> {
    const globalStats = await this.globalProvider.stats();

    const byResource = new Map<CacheableResourceType, CacheStats>();
    for (const [type, provider] of this.providers.entries()) {
      byResource.set(type, await provider.stats());
    }

    return { global: globalStats, byResource };
  }

  /**
   * Generate a consistent cache key
   */
  private generateKey(
    resourceType: CacheableResourceType,
    key: string | Record<string, unknown>,
  ): string {
    const prefix = `${resourceType}:`;

    if (typeof key === "string") {
      return prefix + key.toLowerCase().trim();
    }

    // For object keys, create a deterministic hash
    const sortedJson = this.sortObject(key);
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(sortedJson))
      .digest("hex")
      .substring(0, 16);

    return prefix + hash;
  }

  /**
   * Sort object keys for consistent hashing
   */
  private sortObject(obj: Record<string, unknown>): Record<string, unknown> {
    if (obj === null || typeof obj !== "object") {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sortObject(item as Record<string, unknown>));
    }

    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj).toSorted();

    for (const key of keys) {
      sorted[key] = this.sortObject(obj[key] as Record<string, unknown>);
    }

    return sorted;
  }

  /**
   * Start periodic metrics collection
   */
  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(async () => {
      const stats = await this.getStats();

      // Store aggregated stats
      this.aggregatedStats = stats.byResource;

      // Log significant metrics
      if (stats.global.hitRate < 30 && stats.global.hits + stats.global.misses > 100) {
        console.log(`[Cache] Warning: Low hit rate ${stats.global.hitRate.toFixed(1)}%`);
      }

      if (stats.global.size > stats.global.maxSize * 0.9) {
        console.log(
          `[Cache] Warning: Cache nearly full ${((stats.global.size / stats.global.maxSize) * 100).toFixed(1)}%`,
        );
      }
    }, 60000); // Every minute
  }

  /**
   * Stop metrics collection
   */
  dispose(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
  }

  /**
   * Get cache effectiveness report
   */
  async getEffectivenessReport(): Promise<{
    summary: {
      totalHitRate: number;
      avgLatencyReduction: number;
      memorySaved: number;
      apiCallsSaved: number;
    };
    byResource: Array<{
      type: CacheableResourceType;
      hitRate: number;
      entries: number;
      sizeKB: number;
    }>;
  }> {
    const stats = await this.getStats();
    const report = {
      summary: {
        totalHitRate: stats.global.hitRate,
        avgLatencyReduction: 0,
        memorySaved: 0,
        apiCallsSaved: stats.global.hits,
      },
      byResource: [] as Array<{
        type: CacheableResourceType;
        hitRate: number;
        entries: number;
        sizeKB: number;
      }>,
    };

    for (const [type, typeStats] of stats.byResource.entries()) {
      report.byResource.push({
        type,
        hitRate: typeStats.hitRate,
        entries: typeStats.entries,
        sizeKB: typeStats.size / 1024,
      });

      // Estimate latency reduction (assuming cached = 1ms, uncached = 100-1000ms depending on type)
      const estimatedUncachedLatency =
        type === "web-search" ? 500 : type === "model-response" ? 1000 : 100;
      report.summary.avgLatencyReduction +=
        typeStats.hits * (estimatedUncachedLatency - typeStats.avgLatency);
    }

    report.summary.avgLatencyReduction /= Math.max(1, stats.global.hits);
    report.summary.memorySaved = stats.global.size;

    return report;
  }
}
