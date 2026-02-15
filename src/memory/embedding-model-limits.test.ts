import { describe, it, expect } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { resolveEmbeddingMaxInputTokens } from "./embedding-model-limits.js";

function mockProvider(id: string, model: string, maxInputTokens?: number): EmbeddingProvider {
  return {
    id,
    model,
    maxInputTokens,
    embedQuery: async () => [],
    embedBatch: async () => [],
  };
}

describe("resolveEmbeddingMaxInputTokens", () => {
  it("returns provider.maxInputTokens when set", () => {
    const provider = mockProvider("voyage", "voyage-4-large", 16000);
    expect(resolveEmbeddingMaxInputTokens(provider)).toBe(16000);
  });

  it("returns known limit for voyage-4-large (F4)", () => {
    const provider = mockProvider("voyage", "voyage-4-large");
    expect(resolveEmbeddingMaxInputTokens(provider)).toBe(32000);
  });

  it("returns known limit for voyage-4 (F4)", () => {
    const provider = mockProvider("voyage", "voyage-4");
    expect(resolveEmbeddingMaxInputTokens(provider)).toBe(32000);
  });

  it("returns known limit for voyage-4-lite (F4)", () => {
    const provider = mockProvider("voyage", "voyage-4-lite");
    expect(resolveEmbeddingMaxInputTokens(provider)).toBe(16000);
  });

  it("returns known limit for voyage-3", () => {
    const provider = mockProvider("voyage", "voyage-3");
    expect(resolveEmbeddingMaxInputTokens(provider)).toBe(32000);
  });

  it("returns default for unknown model", () => {
    const provider = mockProvider("unknown", "unknown-model");
    expect(resolveEmbeddingMaxInputTokens(provider)).toBe(8192);
  });

  it("returns conservative fallback for gemini provider", () => {
    const provider = mockProvider("gemini", "unknown-gemini-model");
    expect(resolveEmbeddingMaxInputTokens(provider)).toBe(2048);
  });
});
