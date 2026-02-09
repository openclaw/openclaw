/**
 * OpenClaw AGI - Vector Memory (Embedding Service)
 *
 * Provides embedding generation via Voyage AI for semantic search across
 * episodic memory, graph entities, and learned patterns.
 *
 * API key resolution: reads from `VOYAGE_API_KEY` env var (standard
 * OpenClaw pattern — set via config.env.vars or shell environment).
 *
 * Uses the shared DatabaseManager — never creates its own DB connection.
 *
 * @module agi/vector
 */

import type { EmbedFn } from "../episodic/index.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agi:vector");

// ============================================================================
// CONFIGURATION
// ============================================================================

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-3-lite";
const MAX_BATCH_SIZE = 128;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export interface VoyageConfig {
  apiKey?: string;
  model?: string;
  /** Maximum number of texts per batch request */
  batchSize?: number;
}

// ============================================================================
// VOYAGE AI CLIENT
// ============================================================================

export class VoyageEmbeddingClient {
  private apiKey: string;
  private model: string;
  private batchSize: number;
  private cache = new Map<string, number[]>();

  constructor(config: VoyageConfig = {}) {
    this.apiKey = config.apiKey || resolveVoyageApiKey();
    this.model = config.model || DEFAULT_MODEL;
    this.batchSize = Math.min(config.batchSize || MAX_BATCH_SIZE, MAX_BATCH_SIZE);

    if (!this.apiKey) {
      log.warn(
        "No Voyage AI API key found. Set VOYAGE_API_KEY env var or pass apiKey in config. " +
          "Embedding operations will fail until a key is provided.",
      );
    } else {
      log.info(`VoyageEmbeddingClient initialized (model: ${this.model})`);
    }
  }

  /** Check if the client has a valid API key configured */
  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Embed a single text string.
   *
   * Returns a float[] vector (dimension depends on model).
   * Caches results in-memory to avoid redundant API calls within a session.
   */
  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new VoyageError("No Voyage AI API key configured");
    }

    // Check cache
    const cacheKey = `${this.model}:${text.slice(0, 200)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.embedBatch([text]);
    const embedding = result[0];
    this.cache.set(cacheKey, embedding);
    return embedding;
  }

  /**
   * Embed multiple texts in a single batch request.
   *
   * Automatically chunks into batches of `batchSize` if input exceeds the limit.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new VoyageError("No Voyage AI API key configured");
    }

    if (texts.length === 0) {
      return [];
    }

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchResult = await this.requestEmbeddings(batch);
      results.push(...batchResult);
    }

    return results;
  }

  /** Get the embedding function suitable for passing to EpisodicMemoryManager */
  asEmbedFn(): EmbedFn {
    return (text: string) => this.embed(text);
  }

  /** Clear the in-memory embedding cache */
  clearCache(): void {
    this.cache.clear();
  }

  /** Get cache statistics */
  getCacheStats(): { size: number } {
    return { size: this.cache.size };
  }

  // ============================================================================
  // PRIVATE
  // ============================================================================

  private async requestEmbeddings(texts: string[]): Promise<number[][]> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(VOYAGE_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            input: texts,
            model: this.model,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const statusMsg = `Voyage API error ${response.status}: ${body.slice(0, 300)}`;

          // Rate limit — wait and retry
          if (response.status === 429) {
            const retryAfter = Number(response.headers.get("retry-after")) || 2;
            log.warn(
              `Rate limited by Voyage AI (attempt ${attempt}/${MAX_RETRIES}), waiting ${retryAfter}s`,
            );
            await sleep(retryAfter * 1000);
            continue;
          }

          // Server error — retry with backoff
          if (response.status >= 500) {
            log.warn(`Voyage AI server error (attempt ${attempt}/${MAX_RETRIES}): ${statusMsg}`);
            await sleep(RETRY_DELAY_MS * attempt);
            continue;
          }

          // Client error — don't retry
          throw new VoyageError(statusMsg);
        }

        const data = (await response.json()) as VoyageResponse;
        if (!data.data || !Array.isArray(data.data)) {
          throw new VoyageError(
            `Unexpected Voyage API response shape: ${JSON.stringify(data).slice(0, 200)}`,
          );
        }

        // Sort by index to maintain input order
        const sorted = data.data.toSorted((a, b) => a.index - b.index);
        const embeddings = sorted.map((d) => d.embedding);

        log.debug(
          `Embedded ${texts.length} text(s) → ${embeddings[0]?.length || 0} dims (${data.usage?.total_tokens || 0} tokens)`,
        );
        return embeddings;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof VoyageError && !isRetryable(error)) {
          throw error;
        }
        if (attempt < MAX_RETRIES) {
          log.warn(`Voyage embed attempt ${attempt} failed, retrying: ${lastError.message}`);
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }

    throw lastError || new VoyageError("Embedding failed after retries");
  }
}

// ============================================================================
// TYPES
// ============================================================================

interface VoyageResponse {
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage?: {
    total_tokens: number;
  };
}

// ============================================================================
// ERROR
// ============================================================================

export class VoyageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoyageError";
  }
}

function isRetryable(error: VoyageError): boolean {
  return error.message.includes("429") || error.message.includes("5");
}

// ============================================================================
// KEY RESOLUTION
// ============================================================================

/**
 * Resolve Voyage API key from environment variables.
 *
 * Checks: VOYAGE_API_KEY, VOYAGE_AI_API_KEY
 */
function resolveVoyageApiKey(): string {
  return process.env.VOYAGE_API_KEY?.trim() || process.env.VOYAGE_AI_API_KEY?.trim() || "";
}

// ============================================================================
// UTILITIES
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cosine similarity between two vectors.
 *
 * Exported as a utility for callers that need to compare embeddings
 * outside of the EpisodicMemoryManager's built-in search.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-10) {
    return 0;
  }
  return dot / denom;
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultClient: VoyageEmbeddingClient | undefined;

/**
 * Get or create the default Voyage AI embedding client.
 *
 * This is a singleton — call once and reuse. The embed function returned
 * by `client.asEmbedFn()` can be passed directly to `createNexus()`.
 */
export function getVoyageClient(config?: VoyageConfig): VoyageEmbeddingClient {
  if (!defaultClient) {
    defaultClient = new VoyageEmbeddingClient(config);
  }
  return defaultClient;
}

/**
 * Create an embedding function suitable for EpisodicMemoryManager or Nexus.
 *
 * Usage:
 * ```ts
 * const embedFn = createEmbedFn();
 * const nexus = createNexus({ agentId: "x", embedFn });
 * ```
 */
export function createEmbedFn(config?: VoyageConfig): EmbedFn | undefined {
  const client = getVoyageClient(config);
  if (!client.isConfigured()) {
    log.warn("Voyage AI not configured — embedding disabled");
    return undefined;
  }
  return client.asEmbedFn();
}
