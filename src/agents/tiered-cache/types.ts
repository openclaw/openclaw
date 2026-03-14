/**
 * Tiered Cache Types
 *
 * Type definitions for the three-tier cache system:
 * - GPU VRAM (hot): Active inference, ~48GB, ~900 GB/s
 * - RAM (warm): Offload buffer, ~40GB, ~50 GB/s
 * - Disk (cold): Persistence, unlimited, ~3-7 GB/s
 */

// ============================================================================
// Core Types
// ============================================================================

/** Cache tier identifiers */
export type CacheTier = "gpu" | "ram" | "disk";

/** Location of a cached item */
export type CacheLocation = {
  tier: CacheTier;
  path?: string; // For disk tier
  slotId?: number; // For GPU tier
  ramKey?: string; // For RAM tier
};

/** A cached KV slot with metadata */
export type CachedSlot = {
  id: string; // Unique identifier (usually session ID)
  sessionId: string; // Associated session
  tokenCount: number; // Number of tokens cached
  sizeBytes: number; // Estimated size in bytes
  location: CacheLocation; // Current tier location
  createdAt: number; // Creation timestamp (ms)
  lastAccessedAt: number; // Last access timestamp (ms)
  accessCount: number; // Number of times accessed
  isPinned: boolean; // Prevent eviction if true
  isPrefetch: boolean; // Was this prefetched?
  metadata: SlotMetadata; // Additional metadata
};

/** Additional slot metadata */
export type SlotMetadata = {
  sourcePaths?: string[]; // Source files used for context
  promptHash?: string; // Hash of prompt prefix
  modelId?: string; // Model identifier
  contextWindow?: number; // Context window size
  compressionRatio?: number; // Compression ratio if compressed
};

// ============================================================================
// Configuration Types
// ============================================================================

/** GPU tier configuration */
export type GpuTierConfig = {
  enabled: boolean;
  maxMemoryBytes: number; // Max GPU memory to use
  reservedForModelBytes: number; // Memory reserved for model weights
  maxSlots: number; // Maximum concurrent slots
  slotContextSize: number; // Tokens per slot
  cacheTypeK: "f16" | "q8_0" | "q4_0";
  cacheTypeV: "f16" | "q8_0" | "q4_0";
};

/** RAM tier configuration */
export type RamTierConfig = {
  enabled: boolean;
  maxMemoryBytes: number; // Max RAM to use for cache
  evictionPolicy: "lru" | "lfu" | "fifo";
  prefetchBudgetBytes: number; // Memory budget for prefetching
  pinnedSlots: string[]; // Slot IDs to never evict
};

/** Disk tier configuration */
export type DiskTierConfig = {
  enabled: boolean;
  basePath: string; // Base path for cache files
  maxDiskBytes: number; // Max disk space to use
  compression: "none" | "zstd" | "gzip";
  compressionLevel: number; // Compression level (1-22 for zstd)
  asyncWrites: boolean; // Write asynchronously
  indexDbPath: string; // Path to SQLite index
};

/** Prefetcher configuration */
export type PrefetcherConfig = {
  enabled: boolean;
  maxPrefetchSlots: number; // Max slots to prefetch simultaneously
  predictionWindowMs: number; // How far ahead to predict (ms)
  minConfidence: number; // Minimum confidence to prefetch
  learningEnabled: boolean; // Learn from access patterns
  historySize: number; // Number of access records to keep
};

// ============================================================================
// Speculative Decoding Types
// ============================================================================

/** Speculative decoding implementation type */
export type SpecType =
  | "none"
  | "ngram-cache"
  | "ngram-simple"
  | "ngram-map-k"
  | "ngram-map-k4v"
  | "ngram-mod";

/** Speculative decoding configuration */
export type SpeculativeConfig = {
  enabled: boolean;
  type: SpecType;
  ngramSizeN: number; // N-gram size for lookup (default 12)
  ngramSizeM: number; // M-gram size for draft (default 48)
  ngramMinHits: number; // Min hits for ngram-map (default 1)
  draftMin: number; // Min draft tokens (default 0)
  draftMax: number; // Max draft tokens (default 16)
};

/** Speculative decoding statistics */
export type SpeculativeStats = {
  enabled: boolean;
  type: SpecType;
  acceptanceRate: number; // 0-1, ratio of accepted/generated tokens
  callsBegin: number; // Number of begin calls (new prompt)
  callsGenerate: number; // Number of generate calls
  callsAccumulate: number; // Number of accumulate calls
  draftsGenerated: number; // Number of drafts generated
  draftsAccepted: number; // Number of drafts accepted (partially)
  tokensGenerated: number; // Total tokens generated (including rejected)
  tokensAccepted: number; // Tokens accepted by main model
  durationBeginMs: number; // Duration of begin phase
  durationGenerateMs: number; // Duration of generate phase
  durationAccumulateMs: number; // Duration of accumulate phase
  lastUpdatedAt: number; // Timestamp of last stats update
};

/** Full tiered cache configuration */
export type TieredCacheConfig = {
  gpu: GpuTierConfig;
  ram: RamTierConfig;
  disk: DiskTierConfig;
  prefetcher: PrefetcherConfig;
  speculative: SpeculativeConfig;
  llamaServerUrl: string;
  evictionIntervalMs: number;
  statsIntervalMs: number;
};

// ============================================================================
// Statistics Types
// ============================================================================

/** Per-tier statistics */
export type TierStats = {
  tier: CacheTier;
  itemsCount: number;
  bytesUsed: number;
  bytesAvailable: number;
  hitCount: number;
  missCount: number;
  evictionCount: number;
  promotionCount: number;
  demotionCount: number;
  avgLatencyMs: number;
};

/** Overall cache statistics */
export type CacheStats = {
  gpu: TierStats;
  ram: TierStats;
  disk: TierStats;
  speculative: SpeculativeStats;
  overallHitRate: number;
  overallLatencyMs: number;
  prefetchAccuracy: number;
  lastEvictionAt?: number;
  uptimeMs: number;
};

// ============================================================================
// Operation Types
// ============================================================================

/** Result of a cache lookup */
export type CacheLookupResult = {
  found: boolean;
  slot?: CachedSlot;
  tier?: CacheTier;
  loadTimeMs?: number;
};

/** Result of a cache store */
export type CacheStoreResult = {
  success: boolean;
  slot: CachedSlot;
  storedAt: CacheTier;
  storeTimeMs: number;
};

/** Result of a promotion operation */
export type PromotionResult = {
  success: boolean;
  slot: CachedSlot;
  fromTier: CacheTier;
  toTier: CacheTier;
  transferTimeMs: number;
  bytesTransferred: number;
};

/** Access pattern record for learning */
export type AccessPattern = {
  sessionId: string;
  slotId: string;
  timestamp: number;
  accessType: "hit" | "miss" | "prefetch_hit" | "prefetch_miss";
  sourceTier: CacheTier;
  timeSinceLastAccessMs?: number;
  timeOfDay: number; // Hour of day (0-23)
  dayOfWeek: number; // Day of week (0-6)
};

/** Prediction for prefetching */
export type PrefetchPrediction = {
  slotId: string;
  sessionId: string;
  confidence: number;
  predictedAccessTime: number;
  reason: string;
};

// ============================================================================
// Event Types
// ============================================================================

/** Cache events for monitoring */
export type CacheEvent =
  | { type: "slot_created"; slot: CachedSlot }
  | { type: "slot_accessed"; slot: CachedSlot; tier: CacheTier }
  | { type: "slot_promoted"; slot: CachedSlot; from: CacheTier; to: CacheTier }
  | { type: "slot_demoted"; slot: CachedSlot; from: CacheTier; to: CacheTier }
  | { type: "slot_evicted"; slot: CachedSlot; tier: CacheTier; reason: string }
  | { type: "slot_prefetched"; slot: CachedSlot; confidence: number }
  | { type: "tier_full"; tier: CacheTier; bytesUsed: number }
  | { type: "stats_updated"; stats: CacheStats };

/** Event handler type */
export type CacheEventHandler = (event: CacheEvent) => void;

// ============================================================================
// Default Configuration
// ============================================================================

/** Default GPU tier configuration */
export const DEFAULT_GPU_CONFIG: GpuTierConfig = {
  enabled: true,
  maxMemoryBytes: 48 * 1024 * 1024 * 1024, // 48GB
  reservedForModelBytes: 20 * 1024 * 1024 * 1024, // 20GB for model
  maxSlots: 4,
  slotContextSize: 65536,
  cacheTypeK: "q8_0",
  cacheTypeV: "q8_0",
};

/** Default RAM tier configuration */
export const DEFAULT_RAM_CONFIG: RamTierConfig = {
  enabled: true,
  maxMemoryBytes: 40 * 1024 * 1024 * 1024, // 40GB
  evictionPolicy: "lru",
  prefetchBudgetBytes: 8 * 1024 * 1024 * 1024, // 8GB
  pinnedSlots: [],
};

/** Default disk tier configuration */
export const DEFAULT_DISK_CONFIG: DiskTierConfig = {
  enabled: true,
  basePath: "~/.openclaw/kv-cache",
  maxDiskBytes: 100 * 1024 * 1024 * 1024, // 100GB
  compression: "zstd",
  compressionLevel: 3,
  asyncWrites: true,
  indexDbPath: "~/.openclaw/kv-cache/index.db",
};

/** Default prefetcher configuration */
export const DEFAULT_PREFETCHER_CONFIG: PrefetcherConfig = {
  enabled: true,
  maxPrefetchSlots: 4,
  predictionWindowMs: 5 * 60 * 1000, // 5 minutes
  minConfidence: 0.6,
  learningEnabled: true,
  historySize: 1000,
};

/** Default speculative decoding configuration */
/** Optimized for Qwen3.5:35B (MoE model) */
export const DEFAULT_SPECULATIVE_CONFIG: SpeculativeConfig = {
  enabled: true,
  type: "ngram-mod", // Best for MoE models, shared pool
  ngramSizeN: 24, // Longer n-gram for better matching
  ngramSizeM: 48, // Draft m-gram size
  ngramMinHits: 1, // Minimum hits before drafting
  draftMin: 48, // MoEs benefit from longer drafts
  draftMax: 64, // Max draft tokens
};

/** Full default configuration */
export const DEFAULT_TIERED_CACHE_CONFIG: TieredCacheConfig = {
  gpu: DEFAULT_GPU_CONFIG,
  ram: DEFAULT_RAM_CONFIG,
  disk: DEFAULT_DISK_CONFIG,
  prefetcher: DEFAULT_PREFETCHER_CONFIG,
  speculative: DEFAULT_SPECULATIVE_CONFIG,
  llamaServerUrl: "http://127.0.0.1:18790",
  evictionIntervalMs: 60000, // 1 minute
  statsIntervalMs: 10000, // 10 seconds
};
