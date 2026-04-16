import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../agents/model-auth.js";
import {
  buildGeminiEmbeddingRequest,
  buildGeminiTextEmbeddingRequest,
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  GEMINI_EMBEDDING_2_MODELS,
  isGeminiEmbedding2Model,
  normalizeGeminiModel,
  resolveGeminiOutputDimensionality,
} from "./embeddings-gemini.js";
import {
  createGeminiBatchFetchMock,
  createGeminiFetchMock,
  installFetchMock,
  mockResolvedProviderKey,
  parseFetchBody,
  readFirstFetchRequest,
  type JsonFetchMock,
} from "./embeddings-provider.test-support.js";
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js";

vi.mock("../../agents/model-auth.js", async () => {
  const { createModelAuthMockModule } = await import("../../test-utils/model-auth-mock.js");
  return createModelAuthMockModule();
});

beforeEach(() => {
  vi.useRealTimers();
  vi.doUnmock("undici");
});

afterEach(() => {
  vi.doUnmock("undici");
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function createProviderWithFetch(
  fetchMock: JsonFetchMock,
  options: Partial<Parameters<typeof createGeminiEmbeddingProvider>[0]> & { model: string },
) {
  installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
  mockPublicPinnedHostname();
  mockResolvedProviderKey(authModule.resolveApiKeyForProvider);
  const { provider } = await createGeminiEmbeddingProvider({
    config: {} as never,
    provider: "gemini",
    fallback: "none",
    ...options,
  });
  return provider;
}

describe("buildGeminiTextEmbeddingRequest", () => {
  it("builds a text embedding request with optional model and dimensions", () => {
    expect(
      buildGeminiTextEmbeddingRequest({
        text: "hello",
        taskType: "RETRIEVAL_DOCUMENT",
        modelPath: "models/gemini-embedding-2-preview",
        outputDimensionality: 1536,
      }),
    ).toEqual({
      model: "models/gemini-embedding-2-preview",
      content: { parts: [{ text: "hello" }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 1536,
    });
  });
});

describe("buildGeminiEmbeddingRequest", () => {
  it("builds a multimodal request from structured input parts", () => {
    expect(
      buildGeminiEmbeddingRequest({
        input: {
          text: "Image file: diagram.png",
          parts: [
            { type: "text", text: "Image file: diagram.png" },
            { type: "inline-data", mimeType: "image/png", data: "abc123" },
          ],
        },
        taskType: "RETRIEVAL_DOCUMENT",
        modelPath: "models/gemini-embedding-2-preview",
        outputDimensionality: 1536,
      }),
    ).toEqual({
      model: "models/gemini-embedding-2-preview",
      content: {
        parts: [
          { text: "Image file: diagram.png" },
          { inlineData: { mimeType: "image/png", data: "abc123" } },
        ],
      },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 1536,
    });
  });
});

// ---------- Model detection ----------

describe("isGeminiEmbedding2Model", () => {
  it("returns true for gemini-embedding-2-preview", () => {
    expect(isGeminiEmbedding2Model("gemini-embedding-2-preview")).toBe(true);
  });

  it("returns false for gemini-embedding-001", () => {
    expect(isGeminiEmbedding2Model("gemini-embedding-001")).toBe(false);
  });

  it("returns false for text-embedding-004", () => {
    expect(isGeminiEmbedding2Model("text-embedding-004")).toBe(false);
  });
});

describe("GEMINI_EMBEDDING_2_MODELS", () => {
  it("contains gemini-embedding-2-preview", () => {
    expect(GEMINI_EMBEDDING_2_MODELS.has("gemini-embedding-2-preview")).toBe(true);
  });
});

// ---------- Dimension resolution ----------

describe("resolveGeminiOutputDimensionality", () => {
  it("returns undefined for non-v2 models", () => {
    expect(resolveGeminiOutputDimensionality("gemini-embedding-001")).toBeUndefined();
    expect(resolveGeminiOutputDimensionality("text-embedding-004")).toBeUndefined();
  });

  it("returns 3072 by default for v2 models", () => {
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview")).toBe(3072);
  });

  it("accepts valid dimension values", () => {
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 768)).toBe(768);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 1536)).toBe(1536);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 3072)).toBe(3072);
  });

  it("throws for invalid dimension values", () => {
    expect(() => resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 512)).toThrow(
      /Invalid outputDimensionality 512/,
    );
    expect(() => resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 1024)).toThrow(
      /Valid values: 768, 1536, 3072/,
    );
  });
});

// ---------- Provider behavior ----------

describe("gemini embedding provider", () => {
  it("handles legacy and v2 request/response behavior", async () => {
    const legacyFetch = createGeminiBatchFetchMock(2);
    const legacyProvider = await createProviderWithFetch(legacyFetch, {
      model: "gemini-embedding-001",
    });

    await legacyProvider.embedQuery("test query");
    await legacyProvider.embedBatch(["text1", "text2"]);

    expect(parseFetchBody(legacyFetch, 0)).toMatchObject({
      taskType: "RETRIEVAL_QUERY",
      content: { parts: [{ text: "test query" }] },
    });
    expect(parseFetchBody(legacyFetch, 0)).not.toHaveProperty("outputDimensionality");
    expect(parseFetchBody(legacyFetch, 1)).not.toHaveProperty("outputDimensionality");

    const v2QueryFetch = createGeminiFetchMock([3, 4, Number.NaN]);
    const v2QueryProvider = await createProviderWithFetch(v2QueryFetch, {
      model: "gemini-embedding-2-preview",
    });
    await expect(v2QueryProvider.embedQuery("   ")).resolves.toEqual([]);
    await expect(v2QueryProvider.embedBatch([])).resolves.toEqual([]);
    await expect(v2QueryProvider.embedQuery("test query")).resolves.toEqual([0.6, 0.8, 0]);

    const v2BatchFetch = createGeminiBatchFetchMock(2, [0, Number.POSITIVE_INFINITY, 5]);
    const v2BatchProvider = await createProviderWithFetch(v2BatchFetch, {
      model: "gemini-embedding-2-preview",
    });
    const batch = await v2BatchProvider.embedBatch(["text1", "text2"]);
    expect(batch).toEqual([
      [0, 0, 1],
      [0, 0, 1],
    ]);

    expect(parseFetchBody(v2QueryFetch)).toMatchObject({
      outputDimensionality: 3072,
      taskType: "RETRIEVAL_QUERY",
      content: { parts: [{ text: "test query" }] },
    });
    expect(parseFetchBody(v2BatchFetch).requests).toEqual([
      {
        model: "models/gemini-embedding-2-preview",
        content: { parts: [{ text: "text1" }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 3072,
      },
      {
        model: "models/gemini-embedding-2-preview",
        content: { parts: [{ text: "text2" }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 3072,
      },
    ]);
  });

  it("supports custom dimensions, task type, multimodal inputs, and endpoint URL", async () => {
    const fetchMock = createGeminiBatchFetchMock(2);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
    });

    await provider.embedQuery("test");
    const structuredBatch = await provider.embedBatchInputs?.([
      {
        text: "Image file: diagram.png",
        parts: [
          { type: "text", text: "Image file: diagram.png" },
          { type: "inline-data", mimeType: "image/png", data: "img" },
        ],
      },
      {
        text: "Audio file: note.wav",
        parts: [
          { type: "text", text: "Audio file: note.wav" },
          { type: "inline-data", mimeType: "audio/wav", data: "aud" },
        ],
      },
    ]);
    expect(structuredBatch).toEqual([
      [0.2672612419124244, 0.5345224838248488, 0.8017837257372732],
      [0.2672612419124244, 0.5345224838248488, 0.8017837257372732],
    ]);

    const { url } = readFirstFetchRequest(fetchMock);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent",
    );
    expect(parseFetchBody(fetchMock, 0)).toMatchObject({
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
    });
    expect(parseFetchBody(fetchMock, 1).requests).toEqual([
      {
        model: "models/gemini-embedding-2-preview",
        content: {
          parts: [
            { text: "Image file: diagram.png" },
            { inlineData: { mimeType: "image/png", data: "img" } },
          ],
        },
        taskType: "SEMANTIC_SIMILARITY",
        outputDimensionality: 768,
      },
      {
        model: "models/gemini-embedding-2-preview",
        content: {
          parts: [
            { text: "Audio file: note.wav" },
            { inlineData: { mimeType: "audio/wav", data: "aud" } },
          ],
        },
        taskType: "SEMANTIC_SIMILARITY",
        outputDimensionality: 768,
      },
    ]);
  });
});

// ---------- Model normalization ----------

describe("gemini model normalization", () => {
  it("normalizes known model prefixes and default model", () => {
    expect(normalizeGeminiModel("models/gemini-embedding-2-preview")).toBe(
      "gemini-embedding-2-preview",
    );
    expect(normalizeGeminiModel("gemini/gemini-embedding-2-preview")).toBe(
      "gemini-embedding-2-preview",
    );
    expect(normalizeGeminiModel("google/gemini-embedding-2-preview")).toBe(
      "gemini-embedding-2-preview",
    );
    expect(normalizeGeminiModel("")).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
  });
});
