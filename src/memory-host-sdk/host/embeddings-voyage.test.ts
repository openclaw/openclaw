import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../agents/model-auth.js";
import {
  createEmbeddingDataFetchMock,
  createJsonResponseFetchMock,
  installFetchMock,
  mockResolvedProviderKey,
  type JsonFetchMock,
} from "./embeddings-provider.test-support.js";
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js";

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

let createVoyageEmbeddingProvider: typeof import("./embeddings-voyage.js").createVoyageEmbeddingProvider;
let normalizeVoyageModel: typeof import("./embeddings-voyage.js").normalizeVoyageModel;

beforeAll(async () => {
  ({ createVoyageEmbeddingProvider, normalizeVoyageModel } =
    await import("./embeddings-voyage.js"));
});

beforeEach(() => {
  vi.useRealTimers();
  vi.doUnmock("undici");
});

async function createDefaultVoyageProvider(model: string, fetchMock: JsonFetchMock) {
  installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
  mockPublicPinnedHostname();
  mockResolvedProviderKey(authModule.resolveApiKeyForProvider, "voyage-key-123");
  return createVoyageEmbeddingProvider({
    config: {} as never,
    provider: "voyage",
    model,
    fallback: "none",
  });
}

describe("voyage embedding provider", () => {
  afterEach(() => {
    vi.doUnmock("undici");
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("configures client with correct defaults and headers", async () => {
    const fetchMock = createEmbeddingDataFetchMock();
    const result = await createDefaultVoyageProvider("voyage-4-large", fetchMock);

    await result.provider.embedQuery("test query");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "voyage" }),
    );

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer voyage-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "voyage-4-large",
      input: ["test query"],
      input_type: "query",
    });
  });

  it("respects remote overrides for baseUrl and apiKey", async () => {
    const fetchMock = createEmbeddingDataFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();

    const result = await createVoyageEmbeddingProvider({
      config: {} as never,
      provider: "voyage",
      model: "voyage-4-lite",
      fallback: "none",
      remote: {
        baseUrl: "https://example.com",
        apiKey: "remote-override-key",
        headers: { "X-Custom": "123" },
      },
    });

    await result.provider.embedQuery("test");

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://example.com/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-override-key");
    expect(headers["X-Custom"]).toBe("123");
  });

  it("passes input_type=document for embedBatch", async () => {
    const fetchMock = createJsonResponseFetchMock({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
    });
    const result = await createDefaultVoyageProvider("voyage-4-large", fetchMock);

    await result.provider.embedBatch(["doc1", "doc2"]);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo | URL, RequestInit | undefined];
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "voyage-4-large",
      input: ["doc1", "doc2"],
      input_type: "document",
    });
  });

  it("normalizes model names", async () => {
    expect(normalizeVoyageModel("voyage/voyage-large-2")).toBe("voyage-large-2");
    expect(normalizeVoyageModel("voyage-4-large")).toBe("voyage-4-large");
    expect(normalizeVoyageModel("  voyage-lite  ")).toBe("voyage-lite");
    expect(normalizeVoyageModel("")).toBe("voyage-4-large"); // Default
  });
});
