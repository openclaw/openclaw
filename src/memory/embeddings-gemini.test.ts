import { afterEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../agents/model-auth.js";
import {
  buildFileDataPart,
  buildGeminiParts,
  buildGeminiTextEmbeddingRequest,
  buildInlineDataPart,
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  GEMINI_EMBEDDING_2_MODELS,
  isGeminiEmbedding2Model,
  resolveGeminiOutputDimensionality,
  type GeminiPart,
} from "./embeddings-gemini.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createModelAuthMockModule } = await import("../test-utils/model-auth-mock.js");
  return createModelAuthMockModule();
});

const createGeminiFetchMock = (embeddingValues = [1, 2, 3]) =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ embedding: { values: embeddingValues } }),
  }));

const createGeminiBatchFetchMock = (count: number, embeddingValues = [1, 2, 3]) =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({
      embeddings: Array.from({ length: count }, () => ({ values: embeddingValues })),
    }),
  }));

function readFirstFetchRequest(fetchMock: { mock: { calls: unknown[][] } }) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return { url, init: init as RequestInit | undefined };
}

function parseFetchBody(fetchMock: { mock: { calls: unknown[][] } }, callIndex = 0) {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
}

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function mockResolvedProviderKey(apiKey = "test-key") {
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey,
    mode: "api-key",
    source: "test",
  });
}

// ---------- Helper function tests ----------

describe("buildGeminiParts", () => {
  it("wraps a string into a single text part", () => {
    expect(buildGeminiParts("hello")).toEqual([{ text: "hello" }]);
  });

  it("passes through an existing parts array", () => {
    const parts: GeminiPart[] = [
      { text: "hello" },
      { inlineData: { mimeType: "image/png", data: "base64data" } },
    ];
    expect(buildGeminiParts(parts)).toBe(parts);
  });
});

describe("buildInlineDataPart", () => {
  it("produces the correct shape", () => {
    const part = buildInlineDataPart("image/jpeg", "abc123");
    expect(part).toEqual({
      inlineData: { mimeType: "image/jpeg", data: "abc123" },
    });
  });
});

describe("buildFileDataPart", () => {
  it("produces the correct shape", () => {
    const part = buildFileDataPart("application/pdf", "gs://bucket/file.pdf");
    expect(part).toEqual({
      fileData: { mimeType: "application/pdf", fileUri: "gs://bucket/file.pdf" },
    });
  });
});

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
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-001",
      fallback: "none",
    });

    await provider.embedQuery("test query");

    const body = parseFetchBody(fetchMock);
    expect(body).not.toHaveProperty("outputDimensionality");
    expect(body.taskType).toBe("RETRIEVAL_QUERY");
    expect(body.content).toEqual({ parts: [{ text: "test query" }] });
  });

  it("does NOT include outputDimensionality in embedBatch", async () => {
    const fetchMock = createGeminiBatchFetchMock(2);
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-001",
      fallback: "none",
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
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });

    await provider.embedQuery("test query");

    const body = parseFetchBody(fetchMock);
    expect(body.outputDimensionality).toBe(3072);
    expect(body.taskType).toBe("RETRIEVAL_QUERY");
    expect(body.content).toEqual({ parts: [{ text: "test query" }] });
  });

  it("includes outputDimensionality in embedBatch request", async () => {
    const fetchMock = createGeminiBatchFetchMock(2);
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
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

  it("respects custom outputDimensionality", async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
      outputDimensionality: 768,
    });

    await provider.embedQuery("test");

    const body = parseFetchBody(fetchMock);
    expect(body.outputDimensionality).toBe(768);
  });

  it("uses custom outputDimensionality for each embedBatch request", async () => {
    const fetchMock = createGeminiBatchFetchMock(2);
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
      outputDimensionality: 768,
    });

    await provider.embedBatch(["text1", "text2"]);

    const body = parseFetchBody(fetchMock);
    expect(body.requests).toEqual([
      expect.objectContaining({ outputDimensionality: 768 }),
      expect.objectContaining({ outputDimensionality: 768 }),
    ]);
  });

  it("throws for invalid outputDimensionality", async () => {
    mockResolvedProviderKey();

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

  it("uses correct endpoint URL", async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });

    await provider.embedQuery("test");

    const { url } = readFirstFetchRequest(fetchMock);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent",
    );
  });

  it("allows taskType override via options", async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
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
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

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
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

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
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

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
    vi.stubGlobal("fetch", fetchMock);
    mockResolvedProviderKey();

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
    mockResolvedProviderKey();

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
    mockResolvedProviderKey();

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
