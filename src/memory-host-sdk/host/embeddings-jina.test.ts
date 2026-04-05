import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../agents/model-auth.js";
import { type FetchMock, withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js";

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: async (params: {
    url: string;
    init?: RequestInit;
    fetchImpl?: typeof fetch;
  }) => {
    const fetchImpl = params.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("fetch is not available");
    }
    const response = await fetchImpl(params.url, params.init);
    return {
      response,
      finalUrl: params.url,
      release: async () => {},
    };
  },
}));

vi.mock("../../agents/model-auth.js", async () => {
  const { createModelAuthMockModule } = await import("../../test-utils/model-auth-mock.js");
  return createModelAuthMockModule();
});

const createFetchMock = () => {
  const fetchMock = vi.fn<FetchMock>(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  return withFetchPreconnect(fetchMock);
};

function installFetchMock(fetchMock: typeof globalThis.fetch) {
  vi.stubGlobal("fetch", fetchMock);
}

let createJinaEmbeddingProvider: typeof import("./embeddings-jina.js").createJinaEmbeddingProvider;
let normalizeJinaModel: typeof import("./embeddings-jina.js").normalizeJinaModel;

beforeAll(async () => {
  ({ createJinaEmbeddingProvider, normalizeJinaModel } = await import("./embeddings-jina.js"));
});

beforeEach(() => {
  vi.useRealTimers();
  vi.doUnmock("undici");
});

function mockJinaApiKey() {
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey: "jina-key-123",
    mode: "api-key",
    source: "test",
  });
}

async function createDefaultJinaProvider(
  model: string,
  fetchMock: ReturnType<typeof createFetchMock>,
) {
  installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
  mockPublicPinnedHostname();
  mockJinaApiKey();
  return createJinaEmbeddingProvider({
    config: {} as never,
    provider: "jina",
    model,
    fallback: "none",
  });
}

describe("jina embedding provider", () => {
  afterEach(() => {
    vi.doUnmock("undici");
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("configures client with correct defaults and headers", async () => {
    const fetchMock = createFetchMock();
    const result = await createDefaultJinaProvider("jina-embeddings-v5-text-small", fetchMock);

    await result.provider.embedQuery("test query");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "jina" }),
    );

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://api.jina.ai/v1/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jina-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "jina-embeddings-v5-text-small",
      input: ["test query"],
      task: "retrieval.query",
    });
  });

  it("respects remote overrides for baseUrl and apiKey", async () => {
    const fetchMock = createFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();

    const result = await createJinaEmbeddingProvider({
      config: {} as never,
      provider: "jina",
      model: "jina-embeddings-v5-text-small",
      fallback: "none",
      remote: {
        baseUrl: "https://custom-jina.example.com",
        apiKey: "remote-override-key",
        headers: { "X-Custom": "123" },
      },
    });

    await result.provider.embedQuery("test");

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://custom-jina.example.com/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-override-key");
    expect(headers["X-Custom"]).toBe("123");
  });

  it("passes task=retrieval.passage for embedBatch", async () => {
    const fetchMock = withFetchPreconnect(
      vi.fn<FetchMock>(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const result = await createDefaultJinaProvider("jina-embeddings-v5-text-small", fetchMock);

    await result.provider.embedBatch(["doc1", "doc2"]);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo | URL, RequestInit | undefined];
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "jina-embeddings-v5-text-small",
      input: ["doc1", "doc2"],
      task: "retrieval.passage",
    });
  });

  it("returns empty array for empty input", async () => {
    const fetchMock = createFetchMock();
    const result = await createDefaultJinaProvider("jina-embeddings-v5-text-small", fetchMock);

    const embeddings = await result.provider.embedBatch([]);

    expect(embeddings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes model names", () => {
    expect(normalizeJinaModel("jina/jina-embeddings-v5-text-small")).toBe(
      "jina-embeddings-v5-text-small",
    );
    expect(normalizeJinaModel("jina-embeddings-v5-text-small")).toBe(
      "jina-embeddings-v5-text-small",
    );
    expect(normalizeJinaModel("  jina-embeddings-v5-text-nano  ")).toBe(
      "jina-embeddings-v5-text-nano",
    );
    expect(normalizeJinaModel("")).toBe("jina-embeddings-v5-text-small");
  });
});
