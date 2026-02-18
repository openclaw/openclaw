import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(),
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
    if (auth?.apiKey) {
      return auth.apiKey;
    }
    throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
  },
}));

const createFetchMock = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
  })) as unknown as typeof fetch;

describe("telnyx embedding provider", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("configures client with correct defaults and headers", async () => {
    vi.stubGlobal("fetch", createFetchMock());

    const { createTelnyxEmbeddingProvider } = await import("./embeddings-telnyx.js");
    const authModule = await import("../agents/model-auth.js");

    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "telnyx-key-123",
      mode: "api-key",
      source: "test",
    });

    const result = await createTelnyxEmbeddingProvider({
      config: {} as never,
      provider: "telnyx",
      model: "thenlper/gte-large",
      fallback: "none",
    });

    await result.provider.embedQuery("test query");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "telnyx" }),
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://api.telnyx.com/v2/ai/openai/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer telnyx-key-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "thenlper/gte-large",
      input: ["test query"],
    });
  });

  it("respects remote overrides for baseUrl and apiKey", async () => {
    vi.stubGlobal("fetch", createFetchMock());

    const { createTelnyxEmbeddingProvider } = await import("./embeddings-telnyx.js");

    const result = await createTelnyxEmbeddingProvider({
      config: {} as never,
      provider: "telnyx",
      model: "intfloat/multilingual-e5-large",
      fallback: "none",
      remote: {
        baseUrl: "https://proxy.example.com",
        apiKey: "remote-override-key",
        headers: { "X-Custom": "123" },
      },
    });

    await result.provider.embedQuery("test");

    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://proxy.example.com/embeddings");

    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-override-key");
    expect(headers["X-Custom"]).toBe("123");
  });

  it("does not include input_type for embedBatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        }),
      })) as unknown as typeof fetch,
    );

    const { createTelnyxEmbeddingProvider } = await import("./embeddings-telnyx.js");
    const authModule = await import("../agents/model-auth.js");

    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "telnyx-key-123",
      mode: "api-key",
      source: "test",
    });

    const result = await createTelnyxEmbeddingProvider({
      config: {} as never,
      provider: "telnyx",
      model: "thenlper/gte-large",
      fallback: "none",
    });

    await result.provider.embedBatch(["doc1", "doc2"]);

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "thenlper/gte-large",
      input: ["doc1", "doc2"],
    });
    expect(body).not.toHaveProperty("input_type");
  });

  it("normalizes model names", async () => {
    const { normalizeTelnyxModel } = await import("./embeddings-telnyx.js");
    expect(normalizeTelnyxModel("telnyx/gte-large")).toBe("gte-large");
    expect(normalizeTelnyxModel("thenlper/gte-large")).toBe("thenlper/gte-large");
    expect(normalizeTelnyxModel("  intfloat/multilingual-e5-large  ")).toBe(
      "intfloat/multilingual-e5-large",
    );
    expect(normalizeTelnyxModel("")).toBe("thenlper/gte-large"); // Default
  });
});
