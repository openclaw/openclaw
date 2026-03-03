import { afterEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../agents/model-auth.js";
import { type FetchMock, withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  createOpenrouterEmbeddingProvider,
  normalizeOpenrouterModel,
} from "./embeddings-openrouter.js";

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

function mockOpenrouterApiKey() {
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey: "or-key-123",
    mode: "api-key",
    source: "test",
  });
}

async function createDefaultOpenrouterProvider(
  model: string,
  fetchMock: ReturnType<typeof createFetchMock>,
) {
  vi.stubGlobal("fetch", fetchMock);
  mockOpenrouterApiKey();
  return createOpenrouterEmbeddingProvider({
    config: {} as never,
    provider: "openrouter",
    model,
    fallback: "none",
  });
}

describe("openrouter embedding provider", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("configures client with correct defaults and headers", async () => {
    const fetchMock = createFetchMock();
    const result = await createDefaultOpenrouterProvider(
      "openai/text-embedding-3-small",
      fetchMock,
    );

    await result.provider.embedQuery("test query");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter" }),
    );

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [RequestInfo | URL, RequestInit | undefined];
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer or-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "openai/text-embedding-3-small",
      input: ["test query"],
    });
  });

  it("respects remote overrides for baseUrl and apiKey", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    mockOpenrouterApiKey();

    const result = await createOpenrouterEmbeddingProvider({
      config: {} as never,
      provider: "openrouter",
      model: "openai/text-embedding-3-large",
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

  it("embeds batch correctly", async () => {
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
    const result = await createDefaultOpenrouterProvider(
      "openai/text-embedding-3-small",
      fetchMock,
    );

    const vectors = await result.provider.embedBatch(["doc1", "doc2"]);

    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo | URL, RequestInit | undefined];
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "openai/text-embedding-3-small",
      input: ["doc1", "doc2"],
    });
  });

  it("normalizes model names", () => {
    expect(normalizeOpenrouterModel("openai/text-embedding-3-small")).toBe(
      "openai/text-embedding-3-small",
    );
    expect(normalizeOpenrouterModel("  openai/text-embedding-3-large  ")).toBe(
      "openai/text-embedding-3-large",
    );
    expect(normalizeOpenrouterModel("")).toBe("openai/text-embedding-3-small"); // Default
    // Strips provider prefix
    expect(normalizeOpenrouterModel("openrouter/openai/text-embedding-3-small")).toBe(
      "openai/text-embedding-3-small",
    );
  });
});
