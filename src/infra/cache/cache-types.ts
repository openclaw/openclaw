/**
 * Core cache types and interfaces
 */

export type CacheEntry<T = unknown> = {
  value: T;
  key: string;
  size: number; // Size in bytes
  createdAt: number;
  expiresAt: number;
  accessCount: number;
  lastAccessedAt: number;
  metadata?: Record<string, unknown>;
};

export type CacheOptions = {
  ttl?: number; // Time to live in seconds
  compress?: boolean; // Whether to compress the value
  priority?: "low" | "normal" | "high"; // Cache priority
  tags?: string[]; // Tags for bulk invalidation
};

export type CacheStats = {
  hits: number;
  misses: number;
  evictions: number;
  size: number; // Current size in bytes
  maxSize: number; // Maximum size in bytes
  entries: number; // Number of entries
  hitRate: number; // Hit rate percentage
  avgLatency: number; // Average access latency in ms
};

export type CacheKeyGenerator<T = unknown> = {
  generate(input: T): string;
  normalize(key: string): string;
};

export interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: CacheOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
  size(): Promise<number>;
  stats(): Promise<CacheStats>;
}

export type CacheManagerConfig = {
  provider: "memory" | "redis" | "hybrid";
  maxSizeInMB?: number;
  defaultTTL?: number; // seconds
  compressionThreshold?: number; // bytes
  evictionPolicy?: "lru" | "lfu" | "fifo";
  enableMetrics?: boolean;
  warmupKeys?: string[];
};

export type CacheableResourceType =
  | "web-search"
  | "model-response"
  | "tool-result"
  | "session-context"
  | "embeddings"
  | "directory-lookup";

export type ResourceCacheConfig = {
  type: CacheableResourceType;
  ttl: number;
  maxEntries?: number;
  keyGenerator?: CacheKeyGenerator;
  shouldCache?: (value: unknown) => boolean;
};
