import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// We will test the retry utility and embeddingStatus types from the new file
import type { EmbeddingStatusCoverage } from "./mongodb-embedding-retry.js";
import { retryEmbedding, type EmbeddingStatus } from "./mongodb-embedding-retry.js";

describe("retryEmbedding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns embeddings on first success (no retries needed)", async () => {
    const mockEmbed = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
    const promise = retryEmbedding(mockEmbed, ["hello"]);
    const result = await promise;

    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds on second attempt", async () => {
    vi.useRealTimers();
    let callCount = 0;
    const mockEmbed = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("API timeout");
      }
      return [[0.4, 0.5, 0.6]];
    });

    // backoffBaseMs=1 to make test fast (1ms, 2ms delays instead of 1s, 2s)
    const result = await retryEmbedding(mockEmbed, ["hello"], 3, 1);

    expect(result).toEqual([[0.4, 0.5, 0.6]]);
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all retry attempts", async () => {
    vi.useRealTimers();
    let callCount = 0;
    const mockEmbed = vi.fn(async () => {
      callCount++;
      throw new Error(`fail attempt ${callCount}`);
    });

    await expect(retryEmbedding(mockEmbed, ["hello"], 3, 1)).rejects.toThrow("fail attempt 3");
    expect(mockEmbed).toHaveBeenCalledTimes(3);
  });

  it("succeeds on third attempt (last retry)", async () => {
    vi.useRealTimers();
    let callCount = 0;
    const mockEmbed = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error(`fail ${callCount}`);
      }
      return [[0.7, 0.8, 0.9]];
    });

    // backoffBaseMs=1 for fast test
    const result = await retryEmbedding(mockEmbed, ["hello"], 3, 1);

    expect(result).toEqual([[0.7, 0.8, 0.9]]);
    expect(mockEmbed).toHaveBeenCalledTimes(3);
  });

  it("passes texts through to the embedding function", async () => {
    const mockEmbed = vi.fn(async (texts: string[]) => texts.map(() => [1.0]));
    const texts = ["hello world", "foo bar", "baz"];
    await retryEmbedding(mockEmbed, texts);

    expect(mockEmbed).toHaveBeenCalledWith(texts);
  });
});

describe("EmbeddingStatus type", () => {
  it("accepts valid status values", () => {
    const statuses: EmbeddingStatus[] = ["success", "failed", "pending"];
    expect(statuses).toHaveLength(3);
  });
});

describe("EmbeddingStatusCoverage type", () => {
  it("has expected shape", () => {
    const coverage: EmbeddingStatusCoverage = {
      total: 100,
      success: 80,
      failed: 5,
      pending: 15,
    };
    expect(coverage.total).toBe(100);
    expect(coverage.success).toBe(80);
    expect(coverage.failed).toBe(5);
    expect(coverage.pending).toBe(15);
  });
});
