/**
 * Cache infrastructure for OpenClaw
 * Provides unified caching for various resource types
 */

export { CacheManager } from "./cache-manager.js";
export { LRUCacheProvider } from "./lru-cache-provider.js";

export type {
  CacheEntry,
  CacheOptions,
  CacheStats,
  CacheProvider,
  CacheManagerConfig,
  CacheableResourceType,
  ResourceCacheConfig,
} from "./cache-types.js";

export { createCachedWebSearch, invalidateSearchCache } from "./integrations/web-search-cache.js";
export type { WebSearchParams, WebSearchResult } from "./integrations/web-search-cache.js";

export { createCachedModelCall } from "./integrations/model-response-cache.js";
export type {
  ModelRequestParams,
  ModelResponse,
  ModelCacheOptions,
} from "./integrations/model-response-cache.js";

// Global cache instance (singleton)
import { CacheManager } from "./cache-manager.js";

let globalCache: CacheManager | null = null;

/**
 * Get or create the global cache instance
 */
export function getGlobalCache(
  config?: Partial<import("./cache-types.js").CacheManagerConfig>,
): CacheManager {
  if (!globalCache) {
    globalCache = new CacheManager(config);
  }
  return globalCache;
}

/**
 * Reset the global cache instance
 */
export function resetGlobalCache(): void {
  if (globalCache) {
    globalCache.dispose();
    globalCache = null;
  }
}

/**
 * Cache performance monitor
 */
export class CacheMonitor {
  private interval?: NodeJS.Timeout;

  constructor(private cache: CacheManager) {}

  start(intervalMs: number = 60000): void {
    this.interval = setInterval(async () => {
      const report = await this.cache.getEffectivenessReport();

      if (report.summary.totalHitRate < 20) {
        console.log(
          "[CacheMonitor] Warning: Low cache hit rate:",
          report.summary.totalHitRate.toFixed(1) + "%",
        );
      }

      if (report.summary.apiCallsSaved > 0) {
        console.log(
          "[CacheMonitor] Performance:",
          `Hit rate: ${report.summary.totalHitRate.toFixed(1)}%,`,
          `API calls saved: ${report.summary.apiCallsSaved},`,
          `Avg latency reduction: ${report.summary.avgLatencyReduction.toFixed(0)}ms`,
        );
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }
}
