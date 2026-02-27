import { describe, expect, it } from "vitest";
import { enforceEmbeddingMaxInputTokens } from "./embedding-chunk-limits.js";
import { estimateUtf8Bytes, splitTextToUtf8ByteLimit } from "./embedding-input-limits.js";
import { resolveEmbeddingMaxInputTokens } from "./embedding-model-limits.js";
import type { EmbeddingProvider } from "./embeddings.js";

function createProvider(maxInputTokens: number): EmbeddingProvider {
  return {
    id: "mock",
    model: "mock-embed",
    maxInputTokens,
    embedQuery: async () => [0],
    embedBatch: async () => [[0]],
  };
}

function createProviderWithoutMaxInputTokens(params: {
  id: string;
  model: string;
}): EmbeddingProvider {
  return {
    id: params.id,
    model: params.model,
    embedQuery: async () => [0],
    embedBatch: async () => [[0]],
  };
}

describe("embedding chunk limits", () => {
  it("splits oversized chunks so each embedding input stays <= maxInputTokens bytes", () => {
    const provider = createProvider(8192);
    const input = {
      startLine: 1,
      endLine: 1,
      text: "x".repeat(9000),
      hash: "ignored",
    };

    const out = enforceEmbeddingMaxInputTokens(provider, [input]);
    expect(out.length).toBeGreaterThan(1);
    expect(out.map((chunk) => chunk.text).join("")).toBe(input.text);
    expect(out.every((chunk) => estimateUtf8Bytes(chunk.text) <= 8192)).toBe(true);
    expect(out.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1)).toBe(true);
    expect(out.every((chunk) => typeof chunk.hash === "string" && chunk.hash.length > 0)).toBe(
      true,
    );
  });

  it("does not split inside surrogate pairs (emoji)", () => {
    const provider = createProvider(8192);
    const emoji = "😀";
    const inputText = `${emoji.repeat(2100)}\n${emoji.repeat(2100)}`;

    const out = enforceEmbeddingMaxInputTokens(provider, [
      { startLine: 1, endLine: 2, text: inputText, hash: "ignored" },
    ]);

    expect(out.length).toBeGreaterThan(1);
    expect(out.map((chunk) => chunk.text).join("")).toBe(inputText);
    expect(out.every((chunk) => estimateUtf8Bytes(chunk.text) <= 8192)).toBe(true);

    // If we split inside surrogate pairs we'd likely end up with replacement chars.
    expect(out.map((chunk) => chunk.text).join("")).not.toContain("\uFFFD");
  });

  it("uses conservative fallback limits for local providers without declared maxInputTokens", () => {
    const provider = createProviderWithoutMaxInputTokens({
      id: "local",
      model: "unknown-local-embedding",
    });

    const out = enforceEmbeddingMaxInputTokens(provider, [
      {
        startLine: 1,
        endLine: 1,
        text: "x".repeat(3000),
        hash: "ignored",
      },
    ]);

    expect(out.length).toBeGreaterThan(1);
    expect(out.every((chunk) => estimateUtf8Bytes(chunk.text) <= 2048)).toBe(true);
  });

  it("honors hard safety caps lower than provider maxInputTokens", () => {
    const provider = createProvider(8192);
    const out = enforceEmbeddingMaxInputTokens(
      provider,
      [
        {
          startLine: 1,
          endLine: 1,
          text: "x".repeat(8100),
          hash: "ignored",
        },
      ],
      8000,
    );

    expect(out.length).toBeGreaterThan(1);
    expect(out.every((chunk) => estimateUtf8Bytes(chunk.text) <= 8000)).toBe(true);
  });
});

describe("query text truncation for embedding limits", () => {
  // Mirrors the truncation logic in embedQueryWithTimeout: when a search
  // query exceeds the provider's max input, take the first segment.
  it("truncates oversized query text to fit provider limit", () => {
    const provider = createProvider(2048);
    const oversizedQuery = "x".repeat(5000);
    const maxInputBytes = resolveEmbeddingMaxInputTokens(provider);

    expect(estimateUtf8Bytes(oversizedQuery)).toBeGreaterThan(maxInputBytes);

    const parts = splitTextToUtf8ByteLimit(oversizedQuery, maxInputBytes);
    const truncated = parts[0] ?? oversizedQuery;

    expect(estimateUtf8Bytes(truncated)).toBeLessThanOrEqual(maxInputBytes);
    expect(truncated.length).toBeLessThan(oversizedQuery.length);
  });

  it("does not truncate queries within limit", () => {
    const provider = createProvider(8192);
    const shortQuery = "find all memory entries about cron jobs";
    const maxInputBytes = resolveEmbeddingMaxInputTokens(provider);

    expect(estimateUtf8Bytes(shortQuery)).toBeLessThanOrEqual(maxInputBytes);

    const parts = splitTextToUtf8ByteLimit(shortQuery, maxInputBytes);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(shortQuery);
  });

  it("handles multibyte query text without corruption", () => {
    const provider = createProvider(2048);
    const emoji = "😀";
    const oversizedQuery = emoji.repeat(1500);
    const maxInputBytes = resolveEmbeddingMaxInputTokens(provider);

    expect(estimateUtf8Bytes(oversizedQuery)).toBeGreaterThan(maxInputBytes);

    const parts = splitTextToUtf8ByteLimit(oversizedQuery, maxInputBytes);
    const truncated = parts[0] ?? oversizedQuery;

    expect(estimateUtf8Bytes(truncated)).toBeLessThanOrEqual(maxInputBytes);
    // No surrogate pair corruption
    expect(truncated).not.toContain("\uFFFD");
  });
});
