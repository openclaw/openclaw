import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./provider-auth-runtime.js";
import {
  buildLiveModelProviderConfig,
  buildOpenAICompatibleLiveModelProviderConfig,
  buildOpenAICompatibleProviderFamilyCatalog,
  clearLiveCatalogCacheForTests,
  fetchLiveProviderModelIds,
  LiveModelCatalogHttpError,
  readLiveModelCatalogStringField,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import type { ProviderCatalogContext } from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";
import { fetchWithSsrFGuard } from "./ssrf-runtime.js";

function buildModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function buildFetchGuard(body: unknown): {
  fetchGuard: LiveModelCatalogFetchGuard;
  fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => undefined);
  const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(body)),
    finalUrl: "https://provider.example.test/v1/models",
    release,
  }));
  return { fetchGuard: fetchGuardMock, fetchGuardMock, release };
}

describe("provider-catalog-live-runtime", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([NON_ENV_SECRETREF_MARKER])(
    "fetches and dedupes live model ids with opaque resolved auth %s",
    async (discoveryApiKey) => {
      const { fetchGuard, fetchGuardMock, release } = buildFetchGuard({
        data: [
          { id: "model-a", object: "model" },
          { id: "model-b", object: "model" },
          { id: "embedding-a", object: "embedding" },
          { id: "model-a", object: "model" },
        ],
      });
      const controller = new AbortController();

      await expect(
        fetchLiveProviderModelIds({
          providerId: "provider",
          endpoint: "https://provider.example.test/v1/models",
          apiKey: NON_ENV_SECRETREF_MARKER,
          discoveryApiKey,
          fetchGuard,
          signal: controller.signal,
          timeoutMs: 1234,
        }),
      ).resolves.toEqual(["model-a", "model-b"]);

      expect(fetchGuardMock).toHaveBeenCalledTimes(1);
      const request = fetchGuardMock.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        url: "https://provider.example.test/v1/models",
        auditContext: "provider-model-discovery",
        signal: controller.signal,
      });
      expect(request?.timeoutMs).toBeGreaterThan(0);
      expect(request?.timeoutMs).toBeLessThanOrEqual(1234);
      expect(Number.isInteger(request?.timeoutMs)).toBe(true);
      const headers = request?.init?.headers;
      expect(headers).toBeInstanceOf(Headers);
      expect((headers as Headers).get("authorization")).toBe(`Bearer ${discoveryApiKey}`);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("does not send non-secret SecretRef markers as live catalog bearer tokens", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({ data: [] });
    const buildRequestHeaders = vi.fn(({ apiKey, discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
      ...(apiKey ? { "X-Api-Key": apiKey } : {}),
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        apiKey: NON_ENV_SECRETREF_MARKER,
        fetchGuard,
        buildRequestHeaders,
      }),
    ).resolves.toEqual([]);

    expect(buildRequestHeaders).toHaveBeenCalledWith({
      apiKey: undefined,
      discoveryApiKey: undefined,
    });
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBeNull();
    expect((headers as Headers).get("x-api-key")).toBeNull();
  });

  it("contextualizes paginated malformed JSON through the guarded network path", async () => {
    const credential = "reflected-fake-network-credential";
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      expect(request.headers.authorization).toBe(`Bearer ${credential}`);
      response.setHeader("content-type", "application/json");
      response.end(
        requests === 1
          ? JSON.stringify({
              data: [{ id: "model-a", object: "model" }],
              next: "/models?page=2",
            })
          : credential,
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected local test server address");
    }
    const endpoint = `http://127.0.0.1:${address.port}/models`;
    const fetchGuard: LiveModelCatalogFetchGuard = async (params) =>
      await fetchWithSsrFGuard({
        ...params,
        dispatcherPolicy: { mode: "direct" },
      });

    try {
      const error = await fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint,
        apiKey: credential,
        fetchGuard,
        policy: { allowPrivateNetwork: true, allowedOrigins: [new URL(endpoint).origin] },
        requireHttps: false,
      }).catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        message: "provider model discovery: malformed JSON response",
      });
      expect(String((error as Error).cause)).not.toContain(credential);
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("does not re-add credentials to redirected-origin pagination requests", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            data: [{ id: "model-a", object: "model" }],
            links: { next: "?page=2" },
          }),
        ),
        finalUrl: "https://redirected.example.test/v1/models/",
        release,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
        finalUrl: "https://redirected.example.test/v1/models/?page=2",
        release,
      });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        discoveryApiKey: "provider-token",
        fetchGuard: fetchGuardMock,
        buildRequestHeaders: ({ discoveryApiKey }) => ({
          Accept: "application/json",
          ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
          "ChatGPT-Account-ID": "acct-1",
        }),
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    const firstHeaders = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    const secondHeaders = fetchGuardMock.mock.calls[1]?.[0].init?.headers;
    expect(firstHeaders).toBeInstanceOf(Headers);
    expect(secondHeaders).toBeInstanceOf(Headers);
    expect((firstHeaders as Headers).get("authorization")).toBe("Bearer provider-token");
    expect((firstHeaders as Headers).get("chatgpt-account-id")).toBe("acct-1");
    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://redirected.example.test/v1/models/?page=2",
    );
    expect((secondHeaders as Headers).get("authorization")).toBeNull();
    expect((secondHeaders as Headers).get("chatgpt-account-id")).toBeNull();
    expect((secondHeaders as Headers).get("accept")).toBe("application/json");
  });

  it("fails truncated live catalog pagination instead of returning partial rows", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async ({ url }) => {
      const page = Number(new URL(url).searchParams.get("after") ?? "0");
      return {
        response: new Response(
          JSON.stringify({
            data: [{ id: `model-${page}`, object: "model" }],
            has_more: true,
            next_cursor: String(page + 1),
          }),
        ),
        finalUrl: url,
        release,
      };
    });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).rejects.toThrow("provider model discovery exceeded 50 pages before the catalog completed");

    expect(fetchGuardMock).toHaveBeenCalledTimes(50);
    expect(release).toHaveBeenCalledTimes(50);
  });

  it("fails explicit incomplete live catalog pagination without a supported next page", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [{ id: "model-a", object: "model" }],
          has_more: true,
        }),
      ),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
      }),
    ).rejects.toThrow(
      "provider model discovery did not include a supported next page before the catalog completed",
    );

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([2_000])(
    "uses one timeout budget after a %i ms wall-clock step",
    async (wallClockStep) => {
      vi.useFakeTimers();
      try {
        const release = vi.fn(async () => undefined);
        const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi
          .fn()
          .mockImplementationOnce(async () => {
            await vi.advanceTimersByTimeAsync(800);
            vi.setSystemTime(Date.now() + wallClockStep);
            return {
              response: new Response(
                JSON.stringify({
                  data: [{ id: "model-a", object: "model" }],
                  has_more: true,
                  next_cursor: "cursor-2",
                }),
              ),
              finalUrl: "https://provider.example.test/v1/models",
              release,
            };
          })
          .mockImplementationOnce(async () => ({
            response: new Response(JSON.stringify({ data: [{ id: "model-b", object: "model" }] })),
            finalUrl: "https://provider.example.test/v1/models?after=cursor-2",
            release,
          }));

        await expect(
          fetchLiveProviderModelIds({
            providerId: "provider",
            endpoint: "https://provider.example.test/v1/models",
            fetchGuard: fetchGuardMock,
            timeoutMs: 1_000,
          }),
        ).resolves.toEqual(["model-a", "model-b"]);

        expect(fetchGuardMock).toHaveBeenCalledTimes(2);
        expect(fetchGuardMock.mock.calls[0]?.[0].timeoutMs).toBe(1_000);
        expect(fetchGuardMock.mock.calls[1]?.[0].timeoutMs).toBe(200);
        expect(release).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds an unbounded live catalog success stream and cancels the body", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    let cancelled = false;
    const release = vi.fn(async () => undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response: new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pullCount += 1;
            // Stream a JSON array prefix followed by an effectively endless run of
            // padding so the body never terminates under its own power.
            if (pullCount === 1) {
              controller.enqueue(encoder.encode('[{"id":"model-a","object":"model"},'));
              return;
            }
            controller.enqueue(encoder.encode("0".repeat(1024 * 1024)));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    const error = await fetchLiveProviderModelIds({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard: fetchGuardMock,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Live model catalog response exceeded \d+ bytes/);
    expect(cancelled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled live catalog success stream", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let cancelReason: unknown;
      const release = vi.fn(async () => undefined);
      const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
        response: new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Emit a partial JSON prefix and then idle forever without closing.
              controller.enqueue(encoder.encode('[{"id":"model-a",'));
            },
            cancel(reason) {
              cancelReason = reason;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
        finalUrl: "https://provider.example.test/v1/models",
        release,
      }));

      const resultPromise = fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard: fetchGuardMock,
        timeoutMs: 1234,
      }).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1234);
      const error = await resultPromise;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Live model catalog response stalled: no data received for 1234ms",
      );
      expect(cancelReason).toBeInstanceOf(Error);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws structured HTTP errors after releasing guarded fetches", async () => {
    const release = vi.fn(async () => undefined);
    const response = new Response("{}", { status: 401 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
      response,
      finalUrl: "https://provider.example.test/v1/models",
      release,
    }));

    const error = await fetchLiveProviderModelIds({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      fetchGuard: fetchGuardMock,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LiveModelCatalogHttpError);
    expect(error).toMatchObject({ status: 401 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("shows every listed chat model, excludes non-chat rows and keeps static rows on failure", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard([
      { id: "model-a", object: "model", output_modalities: ["image"] },
      { id: "model-b", object: "model" },
      { id: "unknown-model", object: "model" },
      { id: "sunsetting-chat", object: "model", shutdown_date: "2999-01-01" },
      { id: "vision-chat", object: "model", pipeline_tag: "image-text-to-text" },
      ...[
        "gpt-realtime-2",
        "gpt-audio-mini",
        "grok-2-image",
        "grok-imagine-video",
        "babbage-002",
        "gpt-3.5-turbo-instruct",
      ].map((id) => ({ id, object: "model" })),
      { id: "retired-chat", object: "model", shutdown_date: "2000-01-01" },
    ]);
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildModel("model-a"), buildModel("model-b")];

    const first = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });
    const second = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(first.apiKey).toBe("PROVIDER_API_KEY");
    expect(first.models).toEqual([
      models[1],
      expect.objectContaining({ id: "sunsetting-chat" }),
      expect.objectContaining({ id: "unknown-model", input: ["text"], contextWindow: 128_000 }),
      expect.objectContaining({ id: "vision-chat" }),
    ]);
    expect(second.models).toEqual(first.models);

    clearLiveCatalogCacheForTests();
    fetchGuardMock.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
    });

    expect(fallback.apiKey).toBe("PROVIDER_API_KEY");
    expect(fallback.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
  });

  it("admits and rejects listed rows through the provider id selector", async () => {
    const { fetchGuard } = buildFetchGuard({
      data: [
        { slug: "model-a" },
        { slug: "fresh-chat" },
        { slug: "fresh-embedding" },
        { id: "model-b", object: "model" },
      ],
    });
    const models = [buildModel("model-a"), buildModel("model-b")];

    const provider = await buildLiveModelProviderConfig({
      discoveryMode: "strict",
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig: { api: "openai-completions", baseUrl: "https://provider.example.test/v1" },
      fetchGuard,
      models,
      readModelId: (row) => readLiveModelCatalogStringField(row, "slug"),
    });

    expect(provider.models).toEqual([
      expect.objectContaining({ id: "fresh-chat", input: ["text"] }),
      models[0],
    ]);
  });

  it("builds newly listed text models from OpenAI-compatible catalog metadata", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({
      data: [
        {
          id: "chat-v2",
          object: "model",
          active: true,
          context_window: 262_144,
          max_completion_tokens: 32_768,
          input_modalities: ["text", "image"],
          features: ["reasoning"],
        },
        { id: "text-embedding-4", object: "model" },
        { id: "gpt-image-2-oai", object: "model" },
        { id: "retired-chat", object: "model", active: false },
        { id: "archived-chat", object: "model", archived: true },
        { id: "deprecated-chat", object: "model", deprecated: true },
        {
          id: "fim-only",
          object: "model",
          capabilities: { completion_chat: false, completion_fim: true },
        },
        { id: "image-generation-v2", object: "model", features: ["image_generation"] },
        {
          id: "chat-and-image-v2",
          object: "model",
          capabilities: { completion_chat: true },
          features: ["image_generation"],
        },
        {
          id: "image-only",
          object: "model",
          output_modalities: ["image"],
        },
      ],
    });

    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "provider",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1/",
        models: [buildModel("chat-v1")],
      },
      apiKey: "provider-key",
      fetchGuard,
    });

    expect(provider.models).toEqual([
      expect.objectContaining({ id: "chat-and-image-v2" }),
      expect.objectContaining({
        id: "chat-v2",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 262_144,
        maxTokens: 32_768,
      }),
    ]);
    expect(fetchGuardMock.mock.calls[0]?.[0].url).toBe("https://provider.example.test/v1/models");
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer provider-key");
  });

  it("keeps authored static metadata for live ids already in the provider seed", async () => {
    const { fetchGuard } = buildFetchGuard({
      data: [{ id: "chat-v1", object: "model", context_window: 1 }],
    });
    const seed = buildModel("chat-v1");

    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "provider",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
        models: [seed],
      },
      fetchGuard,
    });

    expect(provider.models).toEqual([seed]);
  });

  it("supports provider-specific model-list paths and headers", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({
      data: [{ id: "claude-next", object: "model" }],
    });

    await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "anthropic-style",
      providerConfig: {
        api: "anthropic-messages",
        baseUrl: "https://provider.example.test",
        models: [buildModel("claude-current")],
      },
      apiKey: "provider-key",
      modelDiscovery: {
        endpointPath: "v1/models",
        buildRequestHeaders: ({ apiKey }) => ({
          "anthropic-version": "2023-06-01",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        }),
      },
      fetchGuard,
    });

    expect(fetchGuardMock.mock.calls[0]?.[0].url).toBe("https://provider.example.test/v1/models");
    const headers = fetchGuardMock.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("x-api-key")).toBe("provider-key");
    expect((headers as Headers).get("anthropic-version")).toBe("2023-06-01");
  });

  it("does not send credentials to a fixed discovery endpoint after a base URL override", async () => {
    const fetchGuardMock: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn();
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://private-proxy.example.test/v1",
      models: [buildModel("chat-current")],
    };

    await expect(
      buildOpenAICompatibleLiveModelProviderConfig({
        providerId: "provider",
        providerConfig,
        apiKey: "private-proxy-key",
        modelDiscovery: {
          endpointUrl: {
            url: "https://provider.example.test/v1/models",
            requireBaseUrl: "https://provider.example.test/v1",
          },
        },
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual({ ...providerConfig, apiKey: "private-proxy-key" });

    expect(fetchGuardMock).not.toHaveBeenCalled();
  });
});

describe("provider catalog live-runtime scope", () => {
  it("scopes shared family credentials and construction to selected entries", async () => {
    const buildPrimary = vi.fn(() => ({
      baseUrl: "not-a-url",
      api: "openai-completions" as const,
      models: [],
    }));
    const buildPlan = vi.fn(() => ({
      baseUrl: "not-a-url",
      api: "openai-completions" as const,
      models: [],
    }));
    const family = buildOpenAICompatibleProviderFamilyCatalog({
      credentialProviderId: "family",
      entries: [
        {
          id: "family",
          label: "Family",
          baseUrl: "not-a-url",
          models: [],
          buildProvider: buildPrimary,
        },
        {
          id: "family-plan",
          label: "Family Plan",
          baseUrl: "not-a-url",
          models: [],
          buildProvider: buildPlan,
        },
      ],
      staticCatalog: async () => ({ providers: {} }),
      augmentModelCatalog: vi.fn(),
    });

    const resolveProviderApiKey = vi.fn(() => ({ apiKey: "family-key" }));
    const context: ProviderCatalogContext = {
      providerIds: ["family-plan"],
      config: {},
      env: {},
      resolveProviderApiKey,
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const result = await family.catalog.run(context);

    expect(result && "providers" in result ? Object.keys(result.providers) : []).toEqual([
      "family-plan",
    ]);
    expect(buildPrimary).not.toHaveBeenCalled();
    expect(buildPlan).toHaveBeenCalledOnce();

    resolveProviderApiKey.mockClear();
    await expect(family.catalog.run({ ...context, providerIds: ["other"] })).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
  });
});
