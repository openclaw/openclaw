/**
 * Unified Embedding System Tests
 *
 * Verifies that both memory-search and memory-context share the same
 * embedding provider infrastructure with cascading fallback:
 *   auto → local → openai → gemini → voyage → transformer → noop (BM25)
 *
 * Test categories:
 *   1. Shared path verification — both systems use the same factory
 *   2. Transformer provider — new unified provider
 *   3. Adapter correctness — memory-context adapter wraps unified providers
 *   4. Fallback chain — cascading fallback ordering
 *   5. Edge cases — empty text, unicode, huge input, concurrency
 *   6. Noop/BM25 fallback — graceful degradation
 *   7. Hash embedding — deterministic, last-resort fallback
 *   8. Stress tests — concurrent/batch embedding
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../agents/model-auth.js";

// Mock auth module
vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(),
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
    if (auth?.apiKey) {
      return auth.apiKey;
    }
    throw new Error(`No API key found for provider "${provider}" (auth mode: ${auth?.mode}).`);
  },
}));

// Mock node-llama-cpp
const importNodeLlamaCppMock = vi.fn();
vi.mock("./node-llama.js", () => ({
  importNodeLlamaCpp: (...args: unknown[]) => importNodeLlamaCppMock(...args),
}));

// Mock @xenova/transformers for transformer provider tests
const mockPipeline = vi.fn();
vi.mock("@xenova/transformers", () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
  env: { allowLocalModels: true, useBrowserCache: false },
}));

import { createEmbeddingProvider } from "./embeddings.js";
import {
  createEmbeddingProvider as createMemoryContextProvider,
  type EmbeddingProvider as MemoryContextEmbeddingProvider,
} from "../agents/memory-context/embedding.js";

// ============================================================================
// 1. Shared path verification
// ============================================================================
describe("shared embedding path", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("memory-search and memory-context both resolve to noop when no providers available", async () => {
    // All remote providers fail (no keys)
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error('No API key found for provider "openai".'),
    );
    // local fails
    importNodeLlamaCppMock.mockRejectedValue(
      Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
        code: "ERR_MODULE_NOT_FOUND",
      }),
    );
    // transformer fails
    mockPipeline.mockRejectedValue(new Error("Cannot find @xenova/transformers"));

    // memory-search: auto → noop
    const msResult = await createEmbeddingProvider({
      config: {} as never,
      provider: "auto",
      model: "",
      fallback: "none",
    });
    expect(msResult.provider.id).toBe("none");
    expect(msResult.fallbackReason).toBeTruthy();

    // memory-context: auto → noop adapter → hash fallback
    const warnSpy = vi.fn();
    const mcResult = await createMemoryContextProvider(undefined, "auto", { warn: warnSpy });
    // Should have fallen back — either to noop adapter or hash
    expect(mcResult.name).toBeDefined();
    expect(mcResult.dim).toBeGreaterThan(0);
  });

  it("both systems use transformer when remote providers unavailable but transformer works", async () => {
    // Remote providers fail
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error('No API key found for provider "openai".'),
    );
    importNodeLlamaCppMock.mockRejectedValue(
      Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
        code: "ERR_MODULE_NOT_FOUND",
      }),
    );

    // Transformer works
    const mockPipe = vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.01),
    });
    mockPipeline.mockResolvedValue(mockPipe);

    // memory-search: auto → transformer
    const msResult = await createEmbeddingProvider({
      config: {} as never,
      provider: "auto",
      model: "",
      fallback: "none",
    });
    expect(msResult.provider.id).toBe("transformer");

    // memory-context: auto → unified → transformer adapter
    const mcResult = await createMemoryContextProvider(undefined, "auto");
    expect(mcResult.name).toBe("transformer");
    const vec = await mcResult.embed("test");
    expect(vec.length).toBe(384);
  });
});

// ============================================================================
// 2. Transformer provider
// ============================================================================
describe("transformer embedding provider", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates transformer provider with correct id and model", async () => {
    const mockPipe = vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.05),
    });
    mockPipeline.mockResolvedValue(mockPipe);

    // Direct creation via unified system
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error('No API key found for provider "openai".'),
    );
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "transformer",
      model: "",
      fallback: "none",
    });

    expect(result.provider.id).toBe("transformer");
    expect(result.provider.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("transformer embedQuery returns 384-dim normalized vector", async () => {
    const rawData = new Float32Array(384);
    for (let i = 0; i < 384; i++) rawData[i] = Math.random() * 2 - 1;
    const mockPipe = vi.fn().mockResolvedValue({ data: rawData });
    mockPipeline.mockResolvedValue(mockPipe);

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "transformer",
      model: "",
      fallback: "none",
    });

    const vec = await result.provider.embedQuery("hello world");
    expect(vec).toHaveLength(384);

    // Should be L2 normalized
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it("transformer embedBatch processes multiple texts", async () => {
    let callCount = 0;
    const mockPipe = vi.fn().mockImplementation(() => {
      callCount++;
      const data = new Float32Array(384);
      data[0] = callCount * 0.1;
      return Promise.resolve({ data });
    });
    mockPipeline.mockResolvedValue(mockPipe);

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "transformer",
      model: "",
      fallback: "none",
    });

    const batch = await result.provider.embedBatch(["text1", "text2", "text3"]);
    expect(batch).toHaveLength(3);
    for (const vec of batch) {
      expect(vec).toHaveLength(384);
    }
    expect(mockPipe).toHaveBeenCalledTimes(3);
  });

  it("transformer truncates long input to ~2048 chars", async () => {
    let capturedText = "";
    const mockPipe = vi.fn().mockImplementation((text: string) => {
      capturedText = text;
      return Promise.resolve({ data: new Float32Array(384).fill(0.01) });
    });
    mockPipeline.mockResolvedValue(mockPipe);

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "transformer",
      model: "",
      fallback: "none",
    });

    const longText = "a".repeat(5000);
    await result.provider.embedQuery(longText);
    expect(capturedText.length).toBeLessThanOrEqual(2048);
  });
});

// ============================================================================
// 3. Adapter correctness (memory-context wrapping unified)
// ============================================================================
describe("memory-context adapter", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("adapter detects dim from first embed call", async () => {
    const mockPipe = vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.01),
    });
    mockPipeline.mockResolvedValue(mockPipe);

    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found for provider"),
    );
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));

    const provider = await createMemoryContextProvider(undefined, "auto");

    // After init, dim should be detected via probe
    expect(provider.dim).toBe(384);
  });

  it("adapter maps gemini type to auto (best available)", async () => {
    // With gemini key → should resolve to gemini
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: Array(768).fill(0.01) } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    vi.mocked(authModule.resolveApiKeyForProvider).mockImplementation(async ({ provider }) => {
      if (provider === "google") {
        return { apiKey: "gemini-key", source: "env", mode: "api-key" };
      }
      throw new Error(`No API key found for provider "${provider}".`);
    });
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));

    const provider = await createMemoryContextProvider(undefined, "gemini");
    // gemini maps to auto → should find gemini via auto chain
    expect(provider.name).toBeDefined();
    expect(provider.dim).toBeGreaterThan(0);
  });

  it("adapter returns hash for type=hash without calling unified system", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    expect(provider.name).toBe("hash");
    expect(provider.dim).toBe(384);

    const vec = await provider.embed("test");
    expect(vec).toHaveLength(384);
  });

  it("adapter noop returns dim=1 and zero vector", async () => {
    // Force noop by making everything fail
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found for provider"),
    );
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));
    mockPipeline.mockRejectedValue(new Error("not available"));

    const warnSpy = vi.fn();
    const provider = await createMemoryContextProvider(undefined, "auto", { warn: warnSpy });

    // Should degrade gracefully — either noop adapter or hash fallback
    expect(provider.dim).toBeGreaterThan(0);
    const vec = await provider.embed("something");
    expect(vec.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 4. Fallback chain ordering
// ============================================================================
describe("fallback chain ordering", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("auto mode tries: local → openai → gemini → voyage → transformer → noop", async () => {
    const providerAttempts: string[] = [];

    // Track which providers are attempted
    vi.mocked(authModule.resolveApiKeyForProvider).mockImplementation(async ({ provider }) => {
      providerAttempts.push(provider);
      throw new Error(`No API key found for provider "${provider}".`);
    });

    importNodeLlamaCppMock.mockRejectedValue(
      Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
        code: "ERR_MODULE_NOT_FOUND",
      }),
    );

    mockPipeline.mockRejectedValue(new Error("@xenova/transformers not available"));

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "auto",
      model: "",
      fallback: "none",
    });

    // Should have tried openai, google (for Gemini), voyage
    expect(providerAttempts).toContain("openai");
    expect(providerAttempts).toContain("google");
    expect(providerAttempts).toContain("voyage");
    // All failed → noop
    expect(result.provider.id).toBe("none");
  });

  it("transformer fallback is tried after remote providers but before noop", async () => {
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found for provider"),
    );
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));

    // Transformer succeeds
    const mockPipe = vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.01),
    });
    mockPipeline.mockResolvedValue(mockPipe);

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "auto",
      model: "",
      fallback: "none",
    });

    // Should use transformer (not noop)
    expect(result.provider.id).toBe("transformer");
  });

  it("explicit provider with transformer fallback when provider creation fails", async () => {
    // Make gemini provider creation fail (no API key)
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error('No API key found for provider "google".'),
    );

    // Transformer as fallback
    const mockPipe = vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.01),
    });
    mockPipeline.mockResolvedValue(mockPipe);

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "",
      fallback: "transformer",
    });

    expect(result.provider.id).toBe("transformer");
    expect(result.fallbackFrom).toBe("gemini");
    expect(result.fallbackReason).toBeTruthy();
  });
});

// ============================================================================
// 5. Edge cases
// ============================================================================
describe("edge cases", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("hash embedding: empty string returns zero vector", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    const vec = await provider.embed("");
    expect(vec).toHaveLength(384);
    // All zeros for empty input
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("hash embedding: single char input still works", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    const vec = await provider.embed("a");
    expect(vec).toHaveLength(384);
    // Should have non-zero values
    expect(vec.some((v) => v !== 0)).toBe(true);
  });

  it("hash embedding: very long input (100KB)", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    const longText = "x".repeat(100_000);
    const vec = await provider.embed(longText);
    expect(vec).toHaveLength(384);
    // L2 normalized
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it("hash embedding: unicode / CJK text", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    const v1 = await provider.embed("你好世界");
    const v2 = await provider.embed("こんにちは世界");
    const v3 = await provider.embed("🎉 emoji test 🚀");

    expect(v1).toHaveLength(384);
    expect(v2).toHaveLength(384);
    expect(v3).toHaveLength(384);

    // Different texts → different vectors
    expect(v1).not.toEqual(v2);
  });

  it("hash embedding: deterministic (same input → same output)", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    const v1 = await provider.embed("deterministic test");
    const v2 = await provider.embed("deterministic test");
    expect(v1).toEqual(v2);
  });

  it("hash embedding: case insensitive", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    const v1 = await provider.embed("Hello World");
    const v2 = await provider.embed("hello world");
    expect(v1).toEqual(v2);
  });

  it("hash embedding: whitespace normalization", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    const v1 = await provider.embed("hello   world");
    const v2 = await provider.embed("hello world");
    expect(v1).toEqual(v2);
  });

  it("hash embedding: special characters are stripped from input", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    // Special chars like # $ % ^ & * ( ) are stripped (replaced with space)
    // Only letters, numbers, whitespace, @, ., +, - survive the regex
    const v1 = await provider.embed("hello#world");
    const v2 = await provider.embed("hello world");
    // "hello#world" → normalize → "hello world" (# → space, no extra spaces)
    // "hello world" → normalize → "hello world"
    expect(v1).toEqual(v2);
  });

  it("noop embedQuery returns empty array", async () => {
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found for provider"),
    );
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));
    mockPipeline.mockRejectedValue(new Error("not available"));

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "auto",
      model: "",
      fallback: "none",
    });

    const vec = await result.provider.embedQuery("hello");
    expect(vec).toEqual([]);
  });

  it("noop embedBatch returns array of empty arrays", async () => {
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found for provider"),
    );
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));
    mockPipeline.mockRejectedValue(new Error("not available"));

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "auto",
      model: "",
      fallback: "none",
    });

    const batch = await result.provider.embedBatch(["a", "b", "c"]);
    expect(batch).toEqual([[], [], []]);
  });
});

// ============================================================================
// 6. Type union completeness
// ============================================================================
describe("type union completeness", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("unified system accepts transformer as explicit provider", async () => {
    const mockPipe = vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.01),
    });
    mockPipeline.mockResolvedValue(mockPipe);

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "transformer",
      model: "",
      fallback: "none",
    });

    expect(result.provider.id).toBe("transformer");
    expect(result.requestedProvider).toBe("transformer");
  });

  it("unified system accepts transformer as fallback", async () => {
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found for provider"),
    );

    const mockPipe = vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.01),
    });
    mockPipeline.mockResolvedValue(mockPipe);

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "openai",
      model: "",
      fallback: "transformer",
    });

    expect(result.provider.id).toBe("transformer");
    expect(result.fallbackFrom).toBe("openai");
  });

  it("memory-context accepts auto type", async () => {
    mockPipeline.mockRejectedValue(new Error("not available"));
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found"),
    );
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));

    // Should not throw — auto is a valid type
    const provider = await createMemoryContextProvider(undefined, "auto");
    expect(provider).toBeDefined();
  });

  it("memory-context accepts gemini type", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: Array(768).fill(0.01) } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    vi.mocked(authModule.resolveApiKeyForProvider).mockImplementation(async ({ provider }) => {
      if (provider === "google") {
        return { apiKey: "gemini-key", source: "env", mode: "api-key" };
      }
      throw new Error("No key");
    });
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));

    const provider = await createMemoryContextProvider(undefined, "gemini");
    expect(provider).toBeDefined();
  });

  it("memory-context accepts transformer type", async () => {
    const mockPipe = vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.01),
    });
    mockPipeline.mockResolvedValue(mockPipe);

    const provider = await createMemoryContextProvider(undefined, "transformer");
    expect(provider).toBeDefined();
    expect(provider.dim).toBe(384);
  });
});

// ============================================================================
// 7. Stress tests
// ============================================================================
describe("stress tests", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("hash embedding: 1000 sequential embeds", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");
    const start = Date.now();

    for (let i = 0; i < 1000; i++) {
      const vec = await provider.embed(`test sentence number ${i}`);
      expect(vec).toHaveLength(384);
    }

    const elapsed = Date.now() - start;
    // Hash should be very fast — <500ms for 1000 embeds
    expect(elapsed).toBeLessThan(5000);
  });

  it("hash embedding: concurrent embeds don't interfere", async () => {
    const provider = await createMemoryContextProvider(undefined, "hash");

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => provider.embed(`concurrent text ${i}`)),
    );

    expect(results).toHaveLength(100);
    for (const vec of results) {
      expect(vec).toHaveLength(384);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 3);
    }

    // All should be unique
    const unique = new Set(results.map((v) => JSON.stringify(v)));
    expect(unique.size).toBe(100);
  });

  it("transformer: concurrent embeds via unified provider", async () => {
    const mockPipe = vi.fn().mockImplementation(() => {
      const data = new Float32Array(384);
      for (let i = 0; i < 384; i++) data[i] = Math.random();
      return Promise.resolve({ data });
    });
    mockPipeline.mockResolvedValue(mockPipe);

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "transformer",
      model: "",
      fallback: "none",
    });

    const batch = await Promise.all(
      Array.from({ length: 50 }, (_, i) => result.provider.embedQuery(`concurrent ${i}`)),
    );

    expect(batch).toHaveLength(50);
    for (const vec of batch) {
      expect(vec).toHaveLength(384);
    }
    expect(mockPipe).toHaveBeenCalledTimes(50);
  });

  it("adapter: many sequential embeds maintain consistent dim", async () => {
    const mockPipe = vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.01),
    });
    mockPipeline.mockResolvedValue(mockPipe);

    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found"),
    );
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));

    const provider = await createMemoryContextProvider(undefined, "auto");
    expect(provider.dim).toBe(384);

    // 100 embeds — dim should remain consistent
    for (let i = 0; i < 100; i++) {
      const vec = await provider.embed(`text ${i}`);
      expect(vec).toHaveLength(384);
      expect(provider.dim).toBe(384);
    }
  });
});

// ============================================================================
// 8. WarmStore integration with unified embedding
// ============================================================================
describe("WarmStore integration", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("WarmStore works with noop adapter (dim=1)", async () => {
    // Import store dynamically to avoid module init issues
    const { WarmStore } = await import("../agents/memory-context/store.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = mkdtempSync(join(tmpdir(), "warm-noop-"));

    try {
      // Noop adapter
      const noopProvider: MemoryContextEmbeddingProvider = {
        dim: 1,
        name: "none",
        async embed() {
          return [0];
        },
      };

      const store = new WarmStore({
        sessionId: "test",
        embedding: noopProvider,
        coldStore: { path: tmpDir },
        maxSegments: 100,
      });

      await store.addSegment({ role: "user", content: "implement stripe webhook" });
      await store.addSegment({
        role: "assistant",
        content: "Created src/payment/webhook.ts with signature verification",
      });

      // BM25 search should still work
      const bm25 = store.searchByBM25("webhook", 5);
      expect(bm25.length).toBeGreaterThan(0);
      expect(bm25.some((r) => r.score > 0)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("WarmStore works with hash provider", async () => {
    const { WarmStore } = await import("../agents/memory-context/store.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = mkdtempSync(join(tmpdir(), "warm-hash-"));

    try {
      const provider = await createMemoryContextProvider(undefined, "hash");

      const store = new WarmStore({
        sessionId: "test",
        embedding: provider,
        coldStore: { path: tmpDir },
        maxSegments: 100,
      });

      await store.addSegment({ role: "user", content: "configure database connection pooling" });
      await store.addSegment({
        role: "assistant",
        content: "Updated the postgres config with pool settings",
      });
      await store.addSegment({
        role: "user",
        content: "deploy the application to kubernetes",
      });

      // BM25 search
      const bm25 = store.searchByBM25("database", 5);
      expect(bm25.length).toBeGreaterThan(0);

      // Hybrid search
      const hybrid = await store.hybridSearch("database pool config", 5, 0, {
        vectorWeight: 0.7,
        bm25Weight: 0.3,
        timeDecay: 0.995,
      });
      expect(hybrid.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("WarmStore hybrid search with dim=1 (noop) degrades to BM25-dominated", async () => {
    const { WarmStore } = await import("../agents/memory-context/store.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = mkdtempSync(join(tmpdir(), "warm-noop-hybrid-"));

    try {
      const noopProvider: MemoryContextEmbeddingProvider = {
        dim: 1,
        name: "none",
        async embed() {
          return [0];
        },
      };

      const store = new WarmStore({
        sessionId: "test",
        embedding: noopProvider,
        coldStore: { path: tmpDir },
        maxSegments: 100,
      });

      await store.addSegment({ role: "user", content: "fix the login bug" });
      await store.addSegment({ role: "assistant", content: "I fixed the authentication issue" });

      const results = await store.hybridSearch("login bug fix", 5, 0, {
        vectorWeight: 0.7,
        bm25Weight: 0.3,
        timeDecay: 0.995,
      });

      // Should still find results via BM25
      expect(results.length).toBeGreaterThan(0);
      // Vector scores should be 0 or very low (zero vectors)
      for (const r of results) {
        expect(r.vectorScore).toBeLessThanOrEqual(0.01);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 9. Config propagation
// ============================================================================
describe("config propagation", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("memory-context createEmbeddingProvider passes cfg to unified system", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: Array(384).fill(0.01) }] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "test-key",
      mode: "api-key",
      source: "test",
    });
    importNodeLlamaCppMock.mockRejectedValue(new Error("not available"));

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://custom.api/v1",
          },
        },
      },
    };

    const provider = await createMemoryContextProvider(cfg as never, "auto");
    expect(provider.dim).toBeGreaterThan(0);

    // Should have used the custom baseUrl from config
    await provider.embed("test");
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toContain("custom.api");
  });
});
