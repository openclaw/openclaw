import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(),
}));

const createFetchMock = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
  })) as unknown as typeof fetch;

describe("embedding provider remote overrides", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("uses remote baseUrl/apiKey and merges headers", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "provider-key",
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://provider.example/v1",
            headers: {
              "X-Provider": "p",
              "X-Shared": "provider",
            },
          },
        },
      },
    };

    const result = await createEmbeddingProvider({
      config: cfg as never,
      provider: "openai",
      remote: {
        baseUrl: "https://remote.example/v1",
        apiKey: "  remote-key  ",
        headers: {
          "X-Shared": "remote",
          "X-Remote": "r",
        },
      },
      model: "text-embedding-3-small",
      fallback: "openai",
    });

    await result.provider.embedQuery("hello");

    expect(authModule.resolveApiKeyForProvider).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://remote.example/v1/embeddings");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Provider"]).toBe("p");
    expect(headers["X-Shared"]).toBe("remote");
    expect(headers["X-Remote"]).toBe("r");
  });

  it("falls back to resolved api key when remote apiKey is blank", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "provider-key",
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://provider.example/v1",
          },
        },
      },
    };

    const result = await createEmbeddingProvider({
      config: cfg as never,
      provider: "openai",
      remote: {
        baseUrl: "https://remote.example/v1",
        apiKey: "   ",
      },
      model: "text-embedding-3-small",
      fallback: "openai",
    });

    await result.provider.embedQuery("hello");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>) ?? {};
    expect(headers.Authorization).toBe("Bearer provider-key");
  });
});

describe("embedding provider local fallback", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.doUnmock("./node-llama.js");
  });

  it("falls back to openai when node-llama-cpp is missing", async () => {
    vi.doMock("./node-llama.js", () => ({
      importNodeLlamaCpp: async () => {
        throw Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    }));

    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("./embeddings.js");
    const authModule = await import("../agents/model-auth.js");
    vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
      apiKey: "provider-key",
    });

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "local",
      model: "text-embedding-3-small",
      fallback: "openai",
    });

    expect(result.provider.id).toBe("openai");
    expect(result.fallbackFrom).toBe("local");
    expect(result.fallbackReason).toContain("node-llama-cpp");
  });

  it("throws a helpful error when local is requested and fallback is none", async () => {
    vi.doMock("./node-llama.js", () => ({
      importNodeLlamaCpp: async () => {
        throw Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    }));

    const { createEmbeddingProvider } = await import("./embeddings.js");

    await expect(
      createEmbeddingProvider({
        config: {} as never,
        provider: "local",
        model: "text-embedding-3-small",
        fallback: "none",
      }),
    ).rejects.toThrow(/optional dependency node-llama-cpp/i);
  });
});
