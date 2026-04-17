import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../agents/model-auth.js";
import {
  buildGeminiEmbeddingRequest,
  buildGeminiTextEmbeddingRequest,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  GEMINI_EMBEDDING_2_MODELS,
  isGeminiEmbedding2Model,
  normalizeGeminiModel,
  resolveGeminiOutputDimensionality,
} from "./embeddings-gemini-request.js";
import {
  createGeminiBatchFetchMock,
  createJsonResponseFetchMock,
  installFetchMock,
  mockResolvedProviderKey,
  parseFetchBody,
  readFirstFetchRequest,
  type JsonFetchMock,
} from "./embeddings-provider.test-support.js";

const { resolveApiKeyForProviderMock } = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(),
}));

vi.mock("../../agents/model-auth.js", () => {
  return {
    resolveApiKeyForProvider: resolveApiKeyForProviderMock,
    requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
      if (auth.apiKey) {
        return auth.apiKey;
      }
      throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth.mode}).`);
    },
  };
});

vi.mock("../../agents/api-key-rotation.js", () => ({
  collectProviderApiKeysForExecution: (params: { primaryApiKey?: string }) =>
    params.primaryApiKey ? [params.primaryApiKey] : [],
  executeWithApiKeyRotation: async <T>(params: {
    apiKeys: string[];
    execute: (apiKey: string) => Promise<T>;
  }) => {
    const apiKey = params.apiKeys[0];
    if (!apiKey) {
      throw new Error('No API keys configured for provider "google".');
    }
    return await params.execute(apiKey);
  },
}));

beforeEach(() => {
  vi.useRealTimers();
  vi.doUnmock("undici");
});

afterEach(() => {
  vi.doUnmock("undici");
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

type GeminiProviderOptions = Parameters<
  typeof import("./embeddings-gemini.js").createGeminiEmbeddingProvider
>[0];

async function createProviderWithFetch(
  fetchMock: JsonFetchMock,
  options: Partial<GeminiProviderOptions> & { model: string },
) {
  installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
  mockResolvedProviderKey(authModule.resolveApiKeyForProvider);
  const { createGeminiEmbeddingProvider } = await import("./embeddings-gemini.js");
  const { provider } = await createGeminiEmbeddingProvider({
    config: {} as never,
    provider: "gemini",
    fallback: "none",
    ...options,
  });
  return provider;
}

describe("Gemini embedding request helpers", () => {
  it("builds requests and resolves model settings", () => {
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
    expect(GEMINI_EMBEDDING_2_MODELS.has("gemini-embedding-2-preview")).toBe(true);
    expect(isGeminiEmbedding2Model("gemini-embedding-2-preview")).toBe(true);
    expect(isGeminiEmbedding2Model("gemini-embedding-001")).toBe(false);
    expect(isGeminiEmbedding2Model("text-embedding-004")).toBe(false);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-001")).toBeUndefined();
    expect(resolveGeminiOutputDimensionality("text-embedding-004")).toBeUndefined();
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview")).toBe(3072);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 768)).toBe(768);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 1536)).toBe(1536);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 3072)).toBe(3072);
    expect(() => resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 512)).toThrow(
      /Invalid outputDimensionality 512/,
    );
    expect(() => resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 1024)).toThrow(
      /Valid values: 768, 1536, 3072/,
    );
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

    const v2Fetch = createJsonResponseFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? {
            embeddings: Array.from({ length: 2 }, () => ({
              values: [0, Number.POSITIVE_INFINITY, 5],
            })),
          }
        : { embedding: { values: [3, 4, Number.NaN] } };
    });
    const v2Provider = await createProviderWithFetch(v2Fetch, {
      model: "gemini-embedding-2-preview",
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
    });
    await expect(v2Provider.embedQuery("   ")).resolves.toEqual([]);
    await expect(v2Provider.embedBatch([])).resolves.toEqual([]);
    await expect(v2Provider.embedQuery("test query")).resolves.toEqual([0.6, 0.8, 0]);

    const structuredBatch = await v2Provider.embedBatchInputs?.([
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
      [0, 0, 1],
      [0, 0, 1],
    ]);

    const { url } = readFirstFetchRequest(v2Fetch);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent",
    );
    expect(parseFetchBody(v2Fetch, 0)).toMatchObject({
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
      content: { parts: [{ text: "test query" }] },
    });
    expect(parseFetchBody(v2Fetch, 1).requests).toEqual([
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
