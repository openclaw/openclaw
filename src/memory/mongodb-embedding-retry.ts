/**
 * Shared embedding retry utility and embeddingStatus types.
 *
 * Used by mongodb-sync.ts, mongodb-kb.ts, and mongodb-structured-memory.ts
 * to provide resilient embedding generation with exponential backoff.
 *
 * @module mongodb-embedding-retry
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:embedding-retry");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Status of embedding generation for a chunk.
 * - "success": Embedding was generated and stored.
 * - "failed": Embedding generation failed after all retries.
 * - "pending": Chunk stored without embedding (initial state or awaiting re-attempt).
 */
export type EmbeddingStatus = "success" | "failed" | "pending";

/**
 * Embedding coverage metrics for getMemoryStats / doctor reporting.
 */
export type EmbeddingStatusCoverage = {
  total: number;
  success: number;
  failed: number;
  pending: number;
};

// ---------------------------------------------------------------------------
// Retry utility
// ---------------------------------------------------------------------------

/** Default retry configuration: 3 attempts, exponential backoff 1s/2s/4s. */
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

/**
 * Retry embedding generation with exponential backoff.
 *
 * @param embedFn - Function that generates embeddings for a batch of texts.
 * @param texts - Array of text strings to embed.
 * @param maxAttempts - Maximum number of attempts (default 3).
 * @param backoffBaseMs - Base delay in ms for exponential backoff (default 1000). Delays: base*1, base*2, base*4...
 * @returns The embedding vectors on success.
 * @throws The last error if all attempts fail.
 */
export async function retryEmbedding(
  embedFn: (texts: string[]) => Promise<number[][]>,
  texts: string[],
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  backoffBaseMs: number = BACKOFF_BASE_MS,
): Promise<number[][]> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await embedFn(texts);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const delayMs = backoffBaseMs * Math.pow(2, attempt - 1);
        log.warn(
          `embedding attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        log.warn(
          `embedding attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. No more retries.`,
        );
      }
    }
  }

  throw lastError!;
}
