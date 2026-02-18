/**
 * LLM Response Cache
 * Caches LLM responses for similar queries to reduce API calls and latency
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

export interface LLMCacheOptions {
  enabled?: boolean;
  ttl?: number;
  maxSize?: number;
  similarityThreshold?: number;
}

export interface CacheEntry {
  key: string;
  messages: Array<{ role: string; content: string }>;
  model: string;
  response: unknown;
  timestamp: number;
  options?: Record<string, unknown>;
  accessCount: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  totalSaved: number;
  hitRate: string;
  size: number;
  maxSize: number;
}

export class LLMResponseCache extends EventEmitter {
  private config: Required<LLMCacheOptions>;
  private cache: Map<string, CacheEntry> = new Map();
  private accessOrder: string[] = [];
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    totalSaved: 0,
  };

  constructor(options: LLMCacheOptions = {}) {
    super();
    this.config = {
      enabled: options.enabled ?? true,
      ttl: options.ttl ?? 3600000,
      maxSize: options.maxSize ?? 1000,
      similarityThreshold: options.similarityThreshold ?? 0.95,
    };
  }

  generateKey(
    messages: Array<{ role: string; content: string }>,
    model: string,
    options: Record<string, unknown> = {},
  ): string {
    const content = messages.map((m) => `${m.role}:${m.content}`).join("|");
    const keyData = {
      content,
      model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      system: options.system,
    };
    return createHash("sha256").update(JSON.stringify(keyData)).digest("hex").slice(0, 32);
  }

  async get(
    messages: Array<{ role: string; content: string }>,
    model: string,
    options: Record<string, unknown> = {},
  ): Promise<{ response: unknown; cached: boolean; cachedAt: number } | null> {
    if (!this.config.enabled) {
      this.stats.misses++;
      return null;
    }

    const key = this.generateKey(messages, model, options);

    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;

      if (Date.now() - entry.timestamp > this.config.ttl) {
        this.cache.delete(key);
        this.stats.misses++;
        return null;
      }

      this.updateAccessOrder(key);
      this.stats.hits++;
      this.stats.totalSaved++;
      this.emit("hit", { key, entry });

      return {
        response: entry.response,
        cached: true,
        cachedAt: entry.timestamp,
      };
    }

    this.stats.misses++;
    return null;
  }

  async set(
    messages: Array<{ role: string; content: string }>,
    model: string,
    response: unknown,
    options: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const key = this.generateKey(messages, model, options);

    if (this.cache.size >= this.config.maxSize) {
      this.evictLRU();
    }

    const entry: CacheEntry = {
      key,
      messages,
      model,
      response,
      timestamp: Date.now(),
      options,
      accessCount: 0,
    };

    this.cache.set(key, entry);
    this.accessOrder.push(key);
    this.emit("set", { key, entry });
  }

  private updateAccessOrder(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx > -1) {
      this.accessOrder.splice(idx, 1);
      this.accessOrder.push(key);
    }
    const entry = this.cache.get(key);
    if (entry) {
      entry.accessCount++;
    }
  }

  private evictLRU(): void {
    while (this.accessOrder.length > 0 && this.cache.size >= this.config.maxSize) {
      const lruKey = this.accessOrder.shift();
      if (lruKey && this.cache.has(lruKey)) {
        this.cache.delete(lruKey);
        this.stats.evictions++;
        this.emit("evict", { key: lruKey });
        break;
      }
    }
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.emit("clear");
  }

  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;
    return {
      ...this.stats,
      hitRate: hitRate.toFixed(4),
      size: this.cache.size,
      maxSize: this.config.maxSize,
    };
  }
}

let globalCache: LLMResponseCache | null = null;

export function getLLMCache(options?: LLMCacheOptions): LLMResponseCache {
  if (!globalCache) {
    globalCache = new LLMResponseCache(options);
  }
  return globalCache;
}

export function clearLLMCache(): void {
  globalCache?.clear();
}
