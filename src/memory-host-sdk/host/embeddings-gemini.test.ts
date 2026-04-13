import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../agents/model-auth.js";
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

function magnitude(values: number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

let buildGeminiEmbeddingRequest: typeof import("./embeddings-gemini.js").buildGeminiEmbeddingRequest;
let buildGeminiTextEmbeddingRequest: typeof import("./embeddings-gemini.js").buildGeminiTextEmbeddingRequest;
let createGeminiEmbeddingProvider: typeof import("./embeddings-gemini.js").createGeminiEmbeddingProvider;
let DEFAULT_GEMINI_EMBEDDING_MODEL: typeof import("./embeddings-gemini.js").DEFAULT_GEMINI_EMBEDDING_MODEL;
let GEMINI_EMBEDDING_2_MODELS: typeof import("./embeddings-gemini.js").GEMINI_EMBEDDING_2_MODELS;
let isGeminiEmbedding2Model: typeof import("./embeddings-gemini.js").isGeminiEmbedding2Model;
let resolveGeminiOutputDimensionality: typeof import("./embeddings-gemini.js").resolveGeminiOutputDimensionality;

beforeAll(async () => {
  vi.doUnmock("undici");
  ({
    buildGeminiEmbeddingRequest,
    buildGeminiTextEmbeddingRequest,
    createGeminiEmbeddingProvider,
    DEFAULT_GEMINI_EMBEDDING_MODEL,
    GEMINI_EMBEDDING_2_MODELS,
    isGeminiEmbedding2Model,
    resolveGeminiOutputDimensionality,
  } = await import("./embeddings-gemini.js"));
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

function expectNormalizedThreeFourVector(embedding: number[]) {
  expect(embedding[0]).toBeCloseTo(0.6, 5);
  expect(embedding[1]).toBeCloseTo(0.8, 5);
  expect(magnitude(embedding)).toBeCloseTo(1, 5);
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

// ---------- Provider: gemini-embedding-001 (backward compat) ----------

describe("gemini-embedding-001 provider (backward compat)", () => {
  it("does NOT include outputDimensionality in embedQuery", async () => {
    const fetchMock = createGeminiFetchMock();
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-001",
    });

    await provider.embedQuery("test query");

    const body = parseFetchBody(fetchMock);
    expect(body).not.toHaveProperty("outputDimensionality");
    expect(body.taskType).toBe("RETRIEVAL_QUERY");
    expect(body.content).toEqual({ parts: [{ text: "test query" }] });
  });

  it("does NOT include outputDimensionality in embedBatch", async () => {
    const fetchMock = createGeminiBatchFetchMock(2);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-001",
    });

    await provider.embedBatch(["text1", "text2"]);

    const body = parseFetchBody(fetchMock);
    expect(body).not.toHaveProperty("outputDimensionality");
  });
});

// ---------- Provider: gemini-embedding-2-preview ----------

describe("gemini-embedding-2-preview provider", () => {
  it("includes outputDimensionality in embedQuery request", async () => {
    const fetchMock = createGeminiFetchMock();
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
    });

    await provider.embedQuery("test query");

    const body = parseFetchBody(fetchMock);
    expect(body.outputDimensionality).toBe(3072);
    expect(body.taskType).toBe("RETRIEVAL_QUERY");
    expect(body.content).toEqual({ parts: [{ text: "test query" }] });
  });

  it("normalizes embedQuery response vectors", async () => {
    const fetchMock = createGeminiFetchMock([3, 4]);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
    });

    const embedding = await provider.embedQuery("test query");

    expectNormalizedThreeFourVector(embedding);
  });

  it("includes outputDimensionality in embedBatch request", async () => {
    const fetchMock = createGeminiBatchFetchMock(2);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
    });

    await provider.embedBatch(["text1", "text2"]);

    const body = parseFetchBody(fetchMock);
    expect(body.requests).toEqual([
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

  it("normalizes embedBatch response vectors", async () => {
    const fetchMock = createGeminiBatchFetchMock(2, [3, 4]);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
    });

    const embeddings = await provider.embedBatch(["text1", "text2"]);

    expect(embeddings).toHaveLength(2);
    for (const embedding of embeddings) {
      expectNormalizedThreeFourVector(embedding);
    }
  });

  it("respects custom outputDimensionality", async () => {
    const fetchMock = createGeminiFetchMock();
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
      outputDimensionality: 768,
    });

    await provider.embedQuery("test");

    const body = parseFetchBody(fetchMock);
    expect(body.outputDimensionality).toBe(768);
  });

  it("sanitizes and normalizes embedQuery responses", async () => {
    const fetchMock = createGeminiFetchMock([3, 4, Number.NaN]);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
    });

    await expect(provider.embedQuery("test")).resolves.toEqual([0.6, 0.8, 0]);
  });

  it("uses custom outputDimensionality for each embedBatch request", async () => {
    const fetchMock = createGeminiBatchFetchMock(2);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
      outputDimensionality: 768,
    });

    await provider.embedBatch(["text1", "text2"]);

    const body = parseFetchBody(fetchMock);
    expect(body.requests).toEqual([
      expect.objectContaining({ outputDimensionality: 768 }),
      expect.objectContaining({ outputDimensionality: 768 }),
    ]);
  });

  it("sanitizes and normalizes structured batch responses", async () => {
    const fetchMock = createGeminiBatchFetchMock(1, [0, Number.POSITIVE_INFINITY, 5]);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
    });

    await expect(
      provider.embedBatchInputs?.([
        {
          text: "Image file: diagram.png",
          parts: [
            { type: "text", text: "Image file: diagram.png" },
            { type: "inline-data", mimeType: "image/png", data: "img" },
          ],
        },
      ]),
    ).resolves.toEqual([[0, 0, 1]]);
  });

  it("supports multimodal embedBatchInputs requests", async () => {
    const fetchMock = createGeminiBatchFetchMock(2);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
    });

    expect(provider.embedBatchInputs).toBeDefined();
    await provider.embedBatchInputs?.([
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

    const body = parseFetchBody(fetchMock);
    expect(body.requests).toEqual([
      {
        model: "models/gemini-embedding-2-preview",
        content: {
          parts: [
            { text: "Image file: diagram.png" },
            { inlineData: { mimeType: "image/png", data: "img" } },
          ],
        },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 3072,
      },
      {
        model: "models/gemini-embedding-2-preview",
        content: {
          parts: [
            { text: "Audio file: note.wav" },
            { inlineData: { mimeType: "audio/wav", data: "aud" } },
          ],
        },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 3072,
      },
    ]);
  });

  it("throws for invalid outputDimensionality", async () => {
    mockResolvedProviderKey(authModule.resolveApiKeyForProvider);

    await expect(
      createGeminiEmbeddingProvider({
        config: {} as never,
        provider: "gemini",
        model: "gemini-embedding-2-preview",
        fallback: "none",
        outputDimensionality: 512,
      }),
    ).rejects.toThrow(/Invalid outputDimensionality 512/);
  });

  it("sanitizes non-finite values before normalization", async () => {
    const fetchMock = createGeminiFetchMock([
      1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
    });

    const embedding = await provider.embedQuery("test");

    expect(embedding).toEqual([1, 0, 0, 0]);
  });

  it("uses correct endpoint URL", async () => {
    const fetchMock = createGeminiFetchMock();
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
    });

    await provider.embedQuery("test");

    const { url } = readFirstFetchRequest(fetchMock);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent",
    );
  });

  it("allows taskType override via options", async () => {
    const fetchMock = createGeminiFetchMock();
    const provider = await createProviderWithFetch(fetchMock, {
      model: "gemini-embedding-2-preview",
      taskType: "SEMANTIC_SIMILARITY",
    });

    await provider.embedQuery("test");

    const body = parseFetchBody(fetchMock);
    expect(body.taskType).toBe("SEMANTIC_SIMILARITY");
  });
});

// ---------- Model normalization ----------

describe("gemini model normalization", () => {
  it("handles models/ prefix for v2 model", async () => {
    const fetchMock = createGeminiFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    mockResolvedProviderKey(authModule.resolveApiKeyForProvider);

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "models/gemini-embedding-2-preview",
      fallback: "none",
    });

    await provider.embedQuery("test");

    const body = parseFetchBody(fetchMock);
    expect(body.outputDimensionality).toBe(3072);
  });

  it("handles gemini/ prefix for v2 model", async () => {
    const fetchMock = createGeminiFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    mockResolvedProviderKey(authModule.resolveApiKeyForProvider);

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini/gemini-embedding-2-preview",
      fallback: "none",
    });

    await provider.embedQuery("test");

    const body = parseFetchBody(fetchMock);
    expect(body.outputDimensionality).toBe(3072);
  });

  it("handles google/ prefix for v2 model", async () => {
    const fetchMock = createGeminiFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    mockResolvedProviderKey(authModule.resolveApiKeyForProvider);

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "google/gemini-embedding-2-preview",
      fallback: "none",
    });

    await provider.embedQuery("test");

    const body = parseFetchBody(fetchMock);
    expect(body.outputDimensionality).toBe(3072);
  });

  it("defaults to gemini-embedding-001 when model is empty", async () => {
    const fetchMock = createGeminiFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockResolvedProviderKey(authModule.resolveApiKeyForProvider);

    const { provider, client } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "",
      fallback: "none",
    });

    expect(client.model).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
    expect(provider.model).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
  });

  it("returns empty array for blank query text", async () => {
    mockResolvedProviderKey(authModule.resolveApiKeyForProvider);

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });

    const result = await provider.embedQuery("   ");
    expect(result).toEqual([]);
  });

  it("returns empty array for empty batch", async () => {
    mockResolvedProviderKey(authModule.resolveApiKeyForProvider);

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });

    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
  });
});
