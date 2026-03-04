/**
 * LLM Gateway Caching System
 *
 * Two-stage caching:
 * 1. Exact cache: SHA-256 hash of request
 * 2. Semantic cache: Vector embeddings similarity search
 */

import * as crypto from "crypto";
import type { CacheEntry, CacheConfig, GatewayRequest, GatewayResponse } from "./types.js";

/**
 * Simple in-memory vector store for semantic caching
 */
class VectorStore {
  private entries: Array<{ key: string; embedding: number[]; value: GatewayResponse }> = [];

  add(key: string, embedding: number[], value: GatewayResponse): void {
    this.entries.push({ key, embedding, value });
  }

  search(
    queryEmbedding: number[],
    threshold: number,
    maxResults: number = 1,
  ): CacheEntry<GatewayResponse>[] {
    const results: Array<{ entry: (typeof this.entries)[0]; similarity: number }> = [];

    for (const entry of this.entries) {
      const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity >= threshold) {
        results.push({ entry, _similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, maxResults).map(({ entry, _similarity }) => ({
      key: entry.key,
      value: entry.value,
      embedding: entry.embedding,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000, // 24 hours
      hits: 0,
      tier: "semantic" as const,
    }));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  clear(): void {
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }
}

/**
 * LRU Cache implementation
 */
class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number, ttl: number) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
  }

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    // Check TTL
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Update hits and move to end (most recently used)
    entry.hits++;
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry;
  }

  set(key: string, value: T): void {
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttl,
      hits: 0,
      tier: "exact",
    };

    this.cache.set(key, entry);
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  entries(): CacheEntry<T>[] {
    return Array.from(this.cache.values());
  }
}

/**
 * Cache key generator
 */
function generateCacheKey(request: GatewayRequest): string {
  // Normalize request for consistent hashing
  const normalized = {
    messages: request.messages.map((msg) => ({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : msg.content,
    })),
    model: request.model,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    tools: request.tools,
  };

  const json = JSON.stringify(normalized);
  return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * Generate embedding for semantic search
 * Uses a simple hash-based embedding (in production, use actual embedding model)
 */
function generateSimpleEmbedding(text: string): number[] {
  const dimension = 128;
  const embedding = Array.from({ length: dimension }).map(() => 0);

  // Simple character-based embedding
  const words = text.toLowerCase().split(/\s+/);

  for (const word of words) {
    const hash = crypto.createHash("md5").update(word).digest();
    for (let i = 0; i < Math.min(8, dimension); i++) {
      const idx = (hash[i] || 0) % dimension;
      embedding[idx] += 1 / words.length;
    }
  }

  // Normalize
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= norm;
    }
  }

  return embedding;
}

/**
 * Main caching system
 */
export class LLMGatewayCache {
  private exactCache: LRUCache<GatewayResponse>;
  private semanticStore: VectorStore;
  private config: CacheConfig;
  private embeddingClient: EmbeddingClient | null = null;

  // Metrics
  private hits = 0;
  private misses = 0;

  constructor(config: CacheConfig) {
    this.config = config;
    this.exactCache = new LRUCache(config.maxExactCacheSize, config.exactCacheTTL);
    this.semanticStore = new VectorStore();
  }

  /**
   * Set embedding client for semantic search
   */
  setEmbeddingClient(client: EmbeddingClient): void {
    this.embeddingClient = client;
  }

  /**
   * Get cached response
   */
  async get(request: GatewayRequest): Promise<GatewayResponse | null> {
    const key = generateCacheKey(request);

    // 1. Check exact cache first
    const exactMatch = this.exactCache.get(key);
    if (exactMatch) {
      this.hits++;
      return { ...exactMatch.value, cached: true };
    }

    // 2. Check semantic cache
    const queryText = this.extractQueryText(request);
    const embedding = await this.getEmbedding(queryText);

    if (embedding) {
      const semanticMatches = this.semanticStore.search(embedding, this.config.similarityThreshold);

      if (semanticMatches.length > 0) {
        this.hits++;
        return { ...semanticMatches[0].value, cached: true };
      }
    }

    this.misses++;
    return null;
  }

  /**
   * Store response in cache
   */
  async set(request: GatewayRequest, response: GatewayResponse): Promise<void> {
    const key = generateCacheKey(request);

    // Store in exact cache
    this.exactCache.set(key, response);

    // Store in semantic cache
    const queryText = this.extractQueryText(request);
    const embedding = await this.getEmbedding(queryText);

    if (embedding) {
      this.semanticStore.add(key, embedding, response);
    }
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.exactCache.clear();
    this.semanticStore.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    exactCacheSize: number;
    semanticCacheSize: number;
    hits: number;
    misses: number;
    hitRate: number;
  } {
    const total = this.hits + this.misses;
    return {
      exactCacheSize: this.exactCache.size(),
      semanticCacheSize: this.semanticStore.size(),
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Extract query text for embedding
   */
  private extractQueryText(request: GatewayRequest): string {
    const texts: string[] = [];

    for (const msg of request.messages) {
      if (msg.role === "user" || msg.role === "system") {
        if (typeof msg.content === "string") {
          texts.push(msg.content);
        } else {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              texts.push(block.text);
            }
          }
        }
      }
    }

    return texts.join(" ").slice(0, 8000); // Limit length
  }

  /**
   * Get embedding for text
   */
  private async getEmbedding(text: string): Promise<number[] | null> {
    // Use external embedding client if available
    if (this.embeddingClient) {
      try {
        return await this.embeddingClient.embed(text);
      } catch {
        // Fall back to simple embedding
      }
    }

    // Use simple hash-based embedding
    return generateSimpleEmbedding(text);
  }
}

/**
 * Embedding client interface
 */
export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

/**
 * OpenAI embedding client implementation
 */
export class OpenAIEmbeddingClient implements EmbeddingClient {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string = "text-embedding-3-small", baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl || "https://api.openai.com/v1";
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text.slice(0, 8191), // OpenAI limit
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }
}

/**
 * Query embedding cache for reusing embeddings
 */
export class QueryEmbeddingCache {
  private cache: Map<string, { embedding: number[]; timestamp: number }>;
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 1000, ttl: number = 3600000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  get(text: string): number[] | undefined {
    const key = this.hashText(text);
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.embedding;
  }

  set(text: string, embedding: number[]): void {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const key = this.hashText(text);
    this.cache.set(key, { embedding, timestamp: Date.now() });
  }

  private hashText(text: string): string {
    return crypto.createHash("md5").update(text.toLowerCase().trim()).digest("hex");
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
