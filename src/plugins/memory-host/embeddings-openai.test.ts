import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOpenAiEmbedding3Model, resolveOpenAiOutputDimensionality } from "./embeddings-openai.js";
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js";

type AuthModule = typeof import("../../agents/model-auth.js");

let authModule: AuthModule;
let createEmbeddingProvider: (typeof import("./embeddings.js"))["createEmbeddingProvider"];

beforeEach(async () => {
  vi.resetModules();
  authModule = await import("../../agents/model-auth.js");
  vi.spyOn(authModule, "resolveApiKeyForProvider");
  ({ createEmbeddingProvider } = await import("./embeddings.js"));
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function requireProvider(result: Awaited<ReturnType<typeof createEmbeddingProvider>>) {
  if (!result.provider) {
    throw new Error("Expected embedding provider");
  }
  return result.provider;
}

function mockResolvedProviderKey(apiKey = "provider-key") {
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey,
    mode: "api-key",
    source: "test",
  });
}

describe("OpenAI Matryoshka dimensionality support", () => {
  describe("isOpenAiEmbedding3Model", () => {
    it("returns true for text-embedding-3-small", () => {
      expect(isOpenAiEmbedding3Model("text-embedding-3-small")).toBe(true);
    });

    it("returns true for text-embedding-3-large", () => {
      expect(isOpenAiEmbedding3Model("text-embedding-3-large")).toBe(true);
    });

    it("returns false for text-embedding-ada-002", () => {
      expect(isOpenAiEmbedding3Model("text-embedding-ada-002")).toBe(false);
    });

    it("returns false for unknown models", () => {
      expect(isOpenAiEmbedding3Model("text-embedding-unknown")).toBe(false);
    });
  });

  describe("resolveOpenAiOutputDimensionality", () => {
    it("returns undefined for non-embedding-3 models", () => {
      expect(resolveOpenAiOutputDimensionality("text-embedding-ada-002", 512)).toBeUndefined();
    });

    it("returns undefined when outputDimensionality is not specified", () => {
      expect(
        resolveOpenAiOutputDimensionality("text-embedding-3-small", undefined),
      ).toBeUndefined();
      expect(
        resolveOpenAiOutputDimensionality("text-embedding-3-large", undefined),
      ).toBeUndefined();
    });

    it("accepts valid dimension for text-embedding-3-small", () => {
      const validDimensions = [256, 512, 768, 1024, 1536];
      for (const dim of validDimensions) {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-small", dim)).toBe(dim);
      }
    });

    it("accepts valid dimension for text-embedding-3-large", () => {
      const validDimensions = [256, 512, 768, 1024, 1536, 2048, 3072];
      for (const dim of validDimensions) {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-large", dim)).toBe(dim);
      }
    });

    it("throws error for invalid dimension for text-embedding-3-small", () => {
      expect(() => resolveOpenAiOutputDimensionality("text-embedding-3-small", 5120)).toThrow(
        /Invalid output dimensionality 5120 for text-embedding-3-small/,
      );
    });

    it("throws error for invalid dimension for text-embedding-3-large", () => {
      expect(() => resolveOpenAiOutputDimensionality("text-embedding-3-large", 5120)).toThrow(
        /Invalid output dimensionality 5120 for text-embedding-3-large/,
      );
    });

    it("includes supported dimensions in error message", () => {
      try {
        resolveOpenAiOutputDimensionality("text-embedding-3-small", 5120);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).toContain("256, 512, 768, 1024, 1536");
      }
    });
  });

  describe("integration with createEmbeddingProvider", () => {
    it("passes dimensions parameter to OpenAI API for embedding-3-small", async () => {
      const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      mockPublicPinnedHostname();
      mockResolvedProviderKey("openai-key");

      const result = await createEmbeddingProvider({
        config: {} as never,
        provider: "openai",
        model: "text-embedding-3-small",
        outputDimensionality: 512,
        fallback: "none",
      });

      const provider = requireProvider(result);
      await provider.embedQuery("hello");

      const url = fetchMock.mock.calls[0]?.[0];
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(url).toBe("https://api.openai.com/v1/embeddings");
      const payload = JSON.parse(init?.body as string) as {
        model?: string;
        dimensions?: number;
      };
      expect(payload.model).toBe("text-embedding-3-small");
      expect(payload.dimensions).toBe(512);
    });

    it("passes dimensions parameter to OpenAI API for embedding-3-large", async () => {
      const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      mockPublicPinnedHostname();
      mockResolvedProviderKey("openai-key");

      const result = await createEmbeddingProvider({
        config: {} as never,
        provider: "openai",
        model: "text-embedding-3-large",
        outputDimensionality: 2048,
        fallback: "none",
      });

      const provider = requireProvider(result);
      await provider.embedQuery("hello");

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(init?.body as string) as {
        model?: string;
        dimensions?: number;
      };
      expect(payload.dimensions).toBe(2048);
    });

    it("does not pass dimensions parameter for non-embedding-3 models", async () => {
      const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      mockPublicPinnedHostname();
      mockResolvedProviderKey("openai-key");

      const result = await createEmbeddingProvider({
        config: {} as never,
        provider: "openai",
        model: "text-embedding-ada-002",
        outputDimensionality: 512,
        fallback: "none",
      });

      const provider = requireProvider(result);
      await provider.embedQuery("hello");

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(init?.body as string) as {
        model?: string;
        dimensions?: number;
      };
      expect(payload.model).toBe("text-embedding-ada-002");
      expect(payload.dimensions).toBeUndefined();
    });

    it("does not pass dimensions parameter when outputDimensionality is not specified", async () => {
      const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      mockPublicPinnedHostname();
      mockResolvedProviderKey("openai-key");

      const result = await createEmbeddingProvider({
        config: {} as never,
        provider: "openai",
        model: "text-embedding-3-small",
        fallback: "none",
      });

      const provider = requireProvider(result);
      await provider.embedQuery("hello");

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(init?.body as string) as {
        model?: string;
        dimensions?: number;
      };
      expect(payload.model).toBe("text-embedding-3-small");
      expect(payload.dimensions).toBeUndefined();
    });

    it("throws error for invalid dimension during provider creation", async () => {
      mockResolvedProviderKey("openai-key");

      await expect(
        createEmbeddingProvider({
          config: {} as never,
          provider: "openai",
          model: "text-embedding-3-small",
          outputDimensionality: 5120,
          fallback: "none",
        }),
      ).rejects.toThrow(/Invalid output dimensionality 5120/);
    });

    it("includes supported dimensions in provider creation error", async () => {
      mockResolvedProviderKey("openai-key");

      try {
        await createEmbeddingProvider({
          config: {} as never,
          provider: "openai",
          model: "text-embedding-3-small",
          outputDimensionality: 5120,
          fallback: "none",
        });
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).toContain("256, 512, 768, 1024, 1536");
      }
    });
  });

  describe("batch embedding with dimensions", () => {
    it("passes dimensions parameter in batch requests", async () => {
      const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }, { embedding: [7, 8, 9] }],
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      mockPublicPinnedHostname();
      mockResolvedProviderKey("openai-key");

      const result = await createEmbeddingProvider({
        config: {} as never,
        provider: "openai",
        model: "text-embedding-3-small",
        outputDimensionality: 512,
        fallback: "none",
      });

      const provider = requireProvider(result);
      await provider.embedBatch(["hello", "world", "test"]);

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(init?.body as string) as {
        model?: string;
        dimensions?: number;
        input?: string[];
      };
      expect(payload.model).toBe("text-embedding-3-small");
      expect(payload.dimensions).toBe(512);
      expect(payload.input).toEqual(["hello", "world", "test"]);
    });
  });

  describe("remote configuration with dimensions", () => {
    it("passes dimensions parameter with remote configuration", async () => {
      const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      mockPublicPinnedHostname();
      mockResolvedProviderKey("openai-key");

      const result = await createEmbeddingProvider({
        config: {} as never,
        provider: "openai",
        remote: {
          baseUrl: "https://custom.openai.com/v1",
          apiKey: "custom-key", // pragma: allowlist secret
        },
        model: "text-embedding-3-large",
        outputDimensionality: 256,
        fallback: "none",
      });

      const provider = requireProvider(result);
      await provider.embedQuery("hello");

      const url = fetchMock.mock.calls[0]?.[0];
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(url).toBe("https://custom.openai.com/v1/embeddings");
      const payload = JSON.parse(init?.body as string) as {
        model?: string;
        dimensions?: number;
      };
      expect(payload.dimensions).toBe(256);
    });
  });
});
