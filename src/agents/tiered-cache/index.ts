/**
 * Tiered Cache Module
 *
 * Exports for the three-tier cache system with speculative decoding support
 */

// Types
export type {
  CacheTier,
  CacheLocation,
  CachedSlot,
  SlotMetadata,
  GpuTierConfig,
  RamTierConfig,
  DiskTierConfig,
  PrefetcherConfig,
  SpecType,
  SpeculativeConfig,
  SpeculativeStats,
  TieredCacheConfig,
  TierStats,
  CacheStats,
  CacheLookupResult,
  CacheStoreResult,
  PromotionResult,
  AccessPattern,
  PrefetchPrediction,
  CacheEvent,
  CacheEventHandler,
} from "./types.js";

export {
  DEFAULT_GPU_CONFIG,
  DEFAULT_RAM_CONFIG,
  DEFAULT_DISK_CONFIG,
  DEFAULT_PREFETCHER_CONFIG,
  DEFAULT_SPECULATIVE_CONFIG,
  DEFAULT_TIERED_CACHE_CONFIG,
} from "./types.js";

// Components
export { DiskCache } from "./disk-cache.js";
export { RamCache } from "./ram-cache.js";
export { GpuCache } from "./gpu-cache.js";
export { Prefetcher } from "./prefetcher.js";
export { SpeculativeMonitor, createSpeculativeMonitor } from "./speculative-monitor.js";

// Main manager
export { TieredCacheManager, createTieredCacheManager } from "./tiered-cache-manager.js";
