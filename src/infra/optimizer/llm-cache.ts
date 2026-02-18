/**
 * LLM Response Cache - High Performance Implementation
 * Features:
 * - O(1) LRU with doubly-linked list + HashMap
 * - Request coalescing (singleflight) to prevent cache stampede
 * - Lazy expiration on access
 * - Memory-efficient key generation
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { getPerformanceMonitor } from "./performance-monitor.js";

export interface LLMCacheOptions {
  enabled?: boolean;
  ttl?: number;
  maxSize?: number;
  maxByteSize?: number;
}

export interface CacheEntry {
  key: string;
  response: unknown;
  timestamp: number;
  byteSize: number;
  accessCount: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  stampedePrevented: number;
  hitRate: string;
  size: number;
  maxSize: number;
  byteSize: number;
  maxByteSize: number;
}

interface LRUNode {
  key: string;
  entry: CacheEntry;
  prev: LRUNode | null;
  next: LRUNode | null;
}

interface PendingRequest {
  promise: Promise<unknown>;
  timestamp: number;
}

export class LLMResponseCache extends EventEmitter {
  private config: Required<LLMCacheOptions>;
  private cache: Map<string, LRUNode> = new Map();
  private head: LRUNode | null = null;
  private tail: LRUNode | null = null;
  private currentByteSize = 0;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    stampedePrevented: 0,
  };

  constructor(options: LLMCacheOptions = {}) {
    super();
    this.config = {
      enabled: options.enabled ?? true,
      ttl: options.ttl ?? 3600000,
      maxSize: options.maxSize ?? 1000,
      maxByteSize: options.maxByteSize ?? 100 * 1024 * 1024,
    };
  }

  private estimateByteSize(response: unknown): number {
    try {
      return JSON.stringify(response).length * 2;
    } catch {
      return 1024;
    }
  }

  private addToHead(node: LRUNode): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }
  }

  private removeNode(node: LRUNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  private moveToHead(node: LRUNode): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  private evictLRU(): void {
    if (!this.tail) {
      return;
    }
    const lru = this.tail;
    this.removeNode(lru);
    this.cache.delete(lru.key);
    this.currentByteSize -= lru.entry.byteSize;
    this.stats.evictions++;
    this.emit("evict", { key: lru.key });
  }

  private evictToFit(newByteSize: number): void {
    while (
      (this.cache.size >= this.config.maxSize ||
        this.currentByteSize + newByteSize > this.config.maxByteSize) &&
      this.cache.size > 0
    ) {
      this.evictLRU();
    }
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp > this.config.ttl;
  }

  getCachedEntry(key: string): CacheEntry | null {
    if (!this.config.enabled) {
      return null;
    }

    const node = this.cache.get(key);
    if (!node) {
      return null;
    }

    if (this.isExpired(node.entry)) {
      this.removeNode(node);
      this.cache.delete(key);
      this.currentByteSize -= node.entry.byteSize;
      return null;
    }

    this.moveToHead(node);
    node.entry.accessCount++;
    this.stats.hits++;
    this.emit("hit", { key, entry: node.entry });
    getPerformanceMonitor()?.recordCacheHit();
    return node.entry;
  }

  setCachedEntry(key: string, response: unknown): void {
    if (!this.config.enabled) {
      return;
    }

    const byteSize = this.estimateByteSize(response);
    this.evictToFit(byteSize);

    const existing = this.cache.get(key);
    if (existing) {
      this.currentByteSize -= existing.entry.byteSize;
      existing.entry.response = response;
      existing.entry.timestamp = Date.now();
      existing.entry.byteSize = byteSize;
      existing.entry.accessCount++;
      this.currentByteSize += byteSize;
      this.moveToHead(existing);
      return;
    }

    const entry: CacheEntry = {
      key,
      response,
      timestamp: Date.now(),
      byteSize,
      accessCount: 0,
    };

    const node: LRUNode = { key, entry, prev: null, next: null };
    this.cache.set(key, node);
    this.addToHead(node);
    this.currentByteSize += byteSize;
    this.emit("set", { key, entry });
  }

  async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    shouldCache: (result: T) => boolean = () => true,
  ): Promise<T> {
    if (!this.config.enabled) {
      return fetcher();
    }

    const cached = this.getCachedEntry(key);
    if (cached) {
      return cached.response as T;
    }

    const pending = this.pendingRequests.get(key);
    if (pending && Date.now() - pending.timestamp < 30000) {
      this.stats.stampedePrevented++;
      return pending.promise as Promise<T>;
    }

    const fetchPromise = fetcher();
    this.pendingRequests.set(key, { promise: fetchPromise, timestamp: Date.now() });

    try {
      const result = await fetchPromise;
      if (shouldCache(result)) {
        this.setCachedEntry(key, result);
      }
      return result;
    } finally {
      this.pendingRequests.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
    this.head = null;
    this.tail = null;
    this.currentByteSize = 0;
    this.pendingRequests.clear();
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
      byteSize: this.currentByteSize,
      maxByteSize: this.config.maxByteSize,
    };
  }

  recordMiss(): void {
    this.stats.misses++;
    getPerformanceMonitor()?.recordCacheMiss();
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

export function generateCacheKey(
  provider: string,
  modelId: string,
  systemPrompt: string | undefined,
  messagesHash: string,
  temperature?: number,
  maxTokens?: number,
): string {
  const systemHash = systemPrompt
    ? createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16)
    : "";
  const data = `${provider}|${modelId}|${systemHash}|${messagesHash}|${temperature ?? ""}|${maxTokens ?? ""}`;
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

export function hashMessages(messages: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16);
}

export function createCachedCompleteSimple(): (
  model: { provider: string; id: string },
  context: { messages: unknown[]; systemPrompt?: string },
  options?: { temperature?: number; maxTokens?: number },
) => Promise<{ response: unknown; cached: boolean }> {
  return async (model, context, options = {}) => {
    const cache = getLLMCache();
    const messagesHash = hashMessages(context.messages);
    const cacheKey = generateCacheKey(
      model.provider,
      model.id,
      context.systemPrompt,
      messagesHash,
      options.temperature,
      options.maxTokens,
    );

    const cached = cache.getCachedEntry(cacheKey);
    if (cached) {
      return { response: cached.response, cached: true };
    }

    return { response: null, cached: false };
  };
}

export function cacheCompleteResponse(
  model: { provider: string; id: string },
  context: { messages: unknown[]; systemPrompt?: string },
  response: unknown,
  options?: { temperature?: number; maxTokens?: number },
): void {
  const cache = getLLMCache();
  const messagesHash = hashMessages(context.messages);
  const cacheKey = generateCacheKey(
    model.provider,
    model.id,
    context.systemPrompt,
    messagesHash,
    options?.temperature,
    options?.maxTokens,
  );
  cache.setCachedEntry(cacheKey, response);
}
