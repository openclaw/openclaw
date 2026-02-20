import { afterEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../agents/model-auth.js";
import { type FetchMock, withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { createDeepseekEmbeddingProvider, normalizeDeepseekModel } from "./embeddings-deepseek.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createModelAuthMockModule } = await import("../test-utils/model-auth-mock.js");
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

function mockDeepseekApiKey() {
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey: "deepseek-key-123",
    mode: "api-key",
    source: "test",
  });
}

async function createDefaultDeepseekProvider(
  model: string,
  fetchMock: ReturnType<typeof createFetchMock>,
) {
  vi.stubGlobal("fetch", fetchMock);
  mockDeepseekApiKey();
  return createDeepseekEmbeddingProvider({
    config: {} as never,
    provider: "deepseek",
    model,
    fallback: "none",
  });
}

describe("deepseek embedding provider", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("configures client with correct defaults and headers", async () => {
    const fetchMock = createFetchMock();
    const result = await createDefaultDeepseekProvider("deepseek-embedding", fetchMock);

    await result.provider.embedQuery("test query");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek" }),
    );

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://api.deepseek.com/v1/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer deepseek-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "deepseek-embedding",
      input: ["test query"],
    });
  });

  it("respects remote overrides for baseUrl and apiKey", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDeepseekEmbeddingProvider({
      config: {} as never,
      provider: "deepseek",
      model: "deepseek-embedding",
      fallback: "none",
      remote: {
        baseUrl: "https://proxy.example.com",
        apiKey: "remote-override-key",
        headers: { "X-Custom": "123" },
      },
    });

    await result.provider.embedQuery("test");

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://proxy.example.com/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-override-key");
    expect(headers["X-Custom"]).toBe("123");
  });

  it("normalizes model names", () => {
    expect(normalizeDeepseekModel("deepseek/deepseek-embedding")).toBe("deepseek-embedding");
    expect(normalizeDeepseekModel("deepseek-embedding")).toBe("deepseek-embedding");
    expect(normalizeDeepseekModel("  deepseek-embed  ")).toBe("deepseek-embed");
    expect(normalizeDeepseekModel("")).toBe("deepseek-embedding");
  });
});
