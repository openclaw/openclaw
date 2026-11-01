import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withProviderCatalogDiscoveryBudget } from "../plugins/provider-catalog-expiry.js";
import { NON_ENV_SECRETREF_MARKER } from "./provider-auth-runtime.js";
import {
  buildLiveModelProviderConfig,
  buildOpenAICompatibleLiveModelProviderConfig,
  buildOpenAICompatibleLiveProviderCatalog,
  buildOpenAICompatibleProviderFamilyCatalog,
  clearLiveCatalogCacheForTests,
  fetchLiveProviderModelIds,
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
  readLiveModelCatalogStringField,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import type { ProviderCatalogContext } from "./provider-catalog-shared.js";
import { buildCatalogModel as buildModel } from "./provider-catalog.test-support.js";
import { fetchWithSsrFGuard } from "./ssrf-runtime.js";
import { withServer } from "./test-helpers/http-test-server.js";

const endpoint = "https://provider.example.test/v1/models";
const requestDefaults = { providerId: "provider", endpoint };
const providerConfig = {
  api: "openai-completions" as const,
  baseUrl: "https://provider.example.test/v1",
};
const fetchIds = (
  options: Omit<Parameters<typeof fetchLiveProviderModelIds>[0], "providerId" | "endpoint">,
) => fetchLiveProviderModelIds({ ...requestDefaults, ...options });
const modelRows = (...ids: string[]) => ids.map((id) => ({ id, object: "model" }));
function catalogResponse(body: unknown, release: () => Promise<void>, finalUrl = endpoint) {
  return {
    response: body instanceof Response ? body : new Response(JSON.stringify(body)),
    finalUrl,
    release,
  };
}
function buildFetchGuard(body: unknown) {
  const release = vi.fn(async () => undefined);
  const fetchGuardMock = vi.fn<LiveModelCatalogFetchGuard>(async () =>
    catalogResponse(body, release),
  );
  return { fetchGuard: fetchGuardMock, fetchGuardMock, release };
}

function requestHeaders(guard: ReturnType<typeof buildFetchGuard>["fetchGuardMock"], index = 0) {
  const headers = guard.mock.calls[index]?.[0].init?.headers;
  assert(headers instanceof Headers);
  return headers;
}

describe("provider-catalog-live-runtime", () => {
  it("retains raw identities for read-time diagnostics before chat filtering", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({
      data: [
        { id: "chat-local", object: "model" },
        { id: "local/chat-local", object: "model" },
        { id: "embed-local", object: "embedding" },
      ],
    });
    const result = await buildOpenAICompatibleLiveProviderCatalog({
      providerId: "local",
      discoveryMode: "strict",
      fetchGuard,
      providerConfig: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1234/v1",
        models: [],
      },
    });
    expect(result?.outcomes).toEqual([
      {
        provider: "local",
        status: "ready",
        modelIdCatalog: {
          baseUrl: "http://127.0.0.1:1234/v1",
          modelIds: ["chat-local", "local/chat-local", "embed-local"],
        },
      },
    ]);
    expect(result).toMatchObject({
      provider: {
        models: expect.arrayContaining([expect.objectContaining({ id: "chat-local" })]),
      },
    });
    expect(fetchGuardMock).toHaveBeenCalledOnce();
  });

  beforeEach(() => clearLiveCatalogCacheForTests());
  afterEach(() => vi.restoreAllMocks());

  it("fetches and dedupes live model ids with opaque resolved auth", async () => {
    const discoveryApiKey = NON_ENV_SECRETREF_MARKER;
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
      fetchIds({
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
    expect(requestHeaders(fetchGuardMock).get("authorization")).toBe(`Bearer ${discoveryApiKey}`);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not send non-secret SecretRef markers as live catalog bearer tokens", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard({ data: [] });
    const buildRequestHeaders = vi.fn(({ apiKey, discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
      ...(apiKey ? { "X-Api-Key": apiKey } : {}),
    }));

    await expect(
      fetchIds({
        apiKey: NON_ENV_SECRETREF_MARKER,
        fetchGuard,
        buildRequestHeaders,
      }),
    ).resolves.toEqual([]);

    expect(buildRequestHeaders).toHaveBeenCalledWith({
      apiKey: undefined,
      discoveryApiKey: undefined,
    });
    const headers = requestHeaders(fetchGuardMock);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("contextualizes paginated malformed JSON through the guarded network path", async () => {
    const credential = "reflected-fake-network-credential";
    let requests = 0;
    await withServer(
      (request, response) => {
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
      },
      async (baseUrl) => {
        const localEndpoint = `${baseUrl}/models`;
        const fetchGuard: LiveModelCatalogFetchGuard = async (params) =>
          await fetchWithSsrFGuard({
            ...params,
            dispatcherPolicy: { mode: "direct" },
          });

        const error = await fetchLiveProviderModelIds({
          providerId: "provider",
          endpoint: localEndpoint,
          apiKey: credential,
          fetchGuard,
          policy: { allowPrivateNetwork: true, allowedOrigins: [new URL(localEndpoint).origin] },
          requireHttps: false,
        }).catch((cause: unknown) => cause);

        expect(error).toMatchObject({
          message: "provider model discovery: malformed JSON response",
        });
        expect(String((error as Error).cause)).not.toContain(credential);
        expect(requests).toBe(2);
      },
    );
  });

  it("does not re-add credentials to redirected-origin pagination requests", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock = vi
      .fn<LiveModelCatalogFetchGuard>()
      .mockResolvedValueOnce(
        catalogResponse(
          { data: modelRows("model-a"), links: { next: "?page=2" } },
          release,
          "https://redirected.example.test/v1/models/",
        ),
      )
      .mockResolvedValueOnce(
        catalogResponse(
          { data: modelRows("model-b") },
          release,
          "https://redirected.example.test/v1/models/?page=2",
        ),
      );

    await expect(
      fetchIds({
        discoveryApiKey: "provider-token",
        fetchGuard: fetchGuardMock,
        buildRequestHeaders: ({ discoveryApiKey }) => ({
          Accept: "application/json",
          ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
          "ChatGPT-Account-ID": "acct-1",
        }),
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    const firstHeaders = requestHeaders(fetchGuardMock);
    const secondHeaders = requestHeaders(fetchGuardMock, 1);
    expect(firstHeaders.get("authorization")).toBe("Bearer provider-token");
    expect(firstHeaders.get("chatgpt-account-id")).toBe("acct-1");
    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(
      "https://redirected.example.test/v1/models/?page=2",
    );
    expect(secondHeaders.get("authorization")).toBeNull();
    expect(secondHeaders.get("chatgpt-account-id")).toBeNull();
    expect(secondHeaders.get("accept")).toBe("application/json");
  });

  it("fails truncated live catalog pagination instead of returning partial rows", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuardMock = vi.fn<LiveModelCatalogFetchGuard>(async ({ url }) => {
      const page = Number(new URL(url).searchParams.get("after") ?? "0");
      return catalogResponse(
        {
          data: modelRows(`model-${page}`),
          has_more: true,
          next_cursor: String(page + 1),
        },
        release,
        url,
      );
    });

    await expect(fetchIds({ fetchGuard: fetchGuardMock })).rejects.toThrow(
      "provider model discovery exceeded 50 pages before the catalog completed",
    );

    expect(fetchGuardMock).toHaveBeenCalledTimes(50);
    expect(release).toHaveBeenCalledTimes(50);
  });

  it("fails explicit incomplete live catalog pagination without a supported next page", async () => {
    const { fetchGuard, fetchGuardMock, release } = buildFetchGuard({
      data: modelRows("model-a"),
      has_more: true,
    });

    await expect(fetchIds({ fetchGuard })).rejects.toThrow(
      "provider model discovery did not include a supported next page before the catalog completed",
    );

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses one timeout budget after a wall-clock step", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(async () => undefined);
      const fetchGuardMock = vi
        .fn<LiveModelCatalogFetchGuard>()
        .mockImplementationOnce(async () => {
          await vi.advanceTimersByTimeAsync(800);
          vi.setSystemTime(Date.now() + 2_000);
          return catalogResponse(
            {
              data: modelRows("model-a"),
              has_more: true,
              next_cursor: "cursor-2",
            },
            release,
          );
        })
        .mockImplementationOnce(async () =>
          catalogResponse({ data: modelRows("model-b") }, release, `${endpoint}?after=cursor-2`),
        );

      await expect(
        fetchIds({
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
  });

  it("bounds an unbounded live catalog success stream and cancels the body", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    let cancelled = false;
    const { fetchGuard, release } = buildFetchGuard(
      new Response(
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
    );

    const error = await fetchIds({ fetchGuard }).catch((err: unknown) => err);

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
      const { fetchGuard, release } = buildFetchGuard(
        new Response(
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
      );

      const resultPromise = fetchIds({
        fetchGuard,
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
    const response = new Response("{}", { status: 401 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const { fetchGuard, release } = buildFetchGuard(response);

    const error = await fetchIds({ fetchGuard }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LiveModelCatalogHttpError);
    expect(error).toMatchObject({ status: 401 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("projects live chat metadata through both builders, caches it and falls back to static rows", async () => {
    const { fetchGuard, fetchGuardMock } = buildFetchGuard([
      { id: "model-a", object: "model", output_modalities: ["image"] },
      { id: "model-b", object: "model" },
      { id: "unknown-model", object: "model" },
      { id: "sunsetting-chat", object: "model", shutdown_date: "2999-01-01" },
      { id: "vision-chat", object: "model", pipeline_tag: "image-text-to-text" },
      ...modelRows(
        "gpt-realtime-2",
        "gpt-audio-mini",
        "grok-2-image",
        "grok-imagine-video",
        "babbage-002",
        "gpt-3.5-turbo-instruct",
      ),
      { id: "retired-chat", object: "model", shutdown_date: "2000-01-01" },
      {
        id: "chat-v2",
        object: "model",
        active: true,
        context_window: 262_144,
        max_completion_tokens: 32_768,
        input_modalities: ["text", "image"],
        features: ["reasoning"],
      },
      { id: "inactive-chat", object: "model", active: false },
      { id: "archived-chat", object: "model", archived: true },
      { id: "deprecated-chat", object: "model", deprecated: true },
      {
        id: "fim-only",
        object: "model",
        capabilities: { completion_chat: false, completion_fim: true },
      },
      {
        id: "chat-and-image-v2",
        object: "model",
        capabilities: { completion_chat: true },
        features: ["image_generation"],
      },
    ]);
    const models = [buildModel("model-a"), buildModel("model-b")];
    const options = {
      ...requestDefaults,
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
    };
    const first = await buildLiveModelProviderConfig({ ...options, ttlMs: 60_000 });
    const second = await buildLiveModelProviderConfig({ ...options, ttlMs: 60_000 });

    expect(fetchGuardMock).toHaveBeenCalledTimes(1);
    expect(first.apiKey).toBe("PROVIDER_API_KEY");
    const expected = [
      expect.objectContaining({ id: "chat-and-image-v2" }),
      expect.objectContaining({
        id: "chat-v2",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 262_144,
        maxTokens: 32_768,
      }),
      models[1],
      expect.objectContaining({ id: "sunsetting-chat" }),
      expect.objectContaining({ id: "unknown-model", input: ["text"], contextWindow: 128_000 }),
      expect.objectContaining({ id: "vision-chat" }),
    ];
    expect(first.models).toEqual(expected);
    expect(second.models).toEqual(first.models);

    const compatible = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "provider",
      providerConfig: {
        ...providerConfig,
        baseUrl: `${providerConfig.baseUrl}/`,
        models: [buildModel("chat-v1"), ...models],
      },
      apiKey: "provider-key",
      fetchGuard,
    });
    expect(compatible.models).toEqual(expected);
    expect(fetchGuardMock.mock.calls[1]?.[0].url).toBe(endpoint);
    expect(requestHeaders(fetchGuardMock, 1).get("authorization")).toBe("Bearer provider-key");

    clearLiveCatalogCacheForTests();
    fetchGuardMock.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildLiveModelProviderConfig(options);

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
      ...requestDefaults,
      providerConfig,
      fetchGuard,
      models,
      readModelId: (row) => readLiveModelCatalogStringField(row, "slug"),
    });

    expect(provider.models).toEqual([
      expect.objectContaining({ id: "fresh-chat", input: ["text"] }),
      models[0],
    ]);
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
    const headers = requestHeaders(fetchGuardMock);
    expect(headers.get("x-api-key")).toBe("provider-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("does not send credentials to a fixed discovery endpoint after a base URL override", async () => {
    const fetchGuardMock = vi.fn<LiveModelCatalogFetchGuard>();
    const proxyConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://private-proxy.example.test/v1",
      models: [buildModel("chat-current")],
    };

    await expect(
      buildOpenAICompatibleLiveModelProviderConfig({
        providerId: "provider",
        providerConfig: proxyConfig,
        apiKey: "private-proxy-key",
        modelDiscovery: {
          endpointUrl: {
            url: "https://provider.example.test/v1/models",
            requireBaseUrl: "https://provider.example.test/v1",
          },
        },
        fetchGuard: fetchGuardMock,
      }),
    ).resolves.toEqual({ ...proxyConfig, apiKey: "private-proxy-key" });

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

it.each([false, true])("isolates cached HTTP caps inside acquisition=%s", async (scoped) => {
  clearLiveCatalogCacheForTests();
  const firstResponse = createDeferred<Awaited<ReturnType<LiveModelCatalogFetchGuard>>>();
  const secondResponse = createDeferred<Awaited<ReturnType<LiveModelCatalogFetchGuard>>>();
  const fetchGuard = vi
    .fn<LiveModelCatalogFetchGuard>()
    .mockImplementationOnce(() => firstResponse.promise)
    .mockImplementationOnce(() => secondResponse.promise);
  const response = (id: string) => ({
    response: new Response(JSON.stringify({ data: [{ id }] })),
    finalUrl: "https://caps.example.test/models",
    release: async () => undefined,
  });
  const run = async () => {
    const read = (timeoutMs?: number) =>
      getCachedLiveProviderModelRows({
        providerId: "caps",
        endpoint: "https://caps.example.test/models",
        timeoutMs,
        fetchGuard,
      });
    const short = read(5_000);
    const long = read(scoped ? undefined : 180_000);
    try {
      expect(fetchGuard).toHaveBeenCalledTimes(2);
      expect(fetchGuard.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(5_000);
      expect(fetchGuard.mock.calls[1]?.[0].timeoutMs).toBeGreaterThan(5_000);
    } finally {
      firstResponse.resolve(response("short"));
      secondResponse.resolve(response("long"));
    }
    expect(await short).toEqual([{ id: "short" }]);
    expect(await long).toEqual([{ id: "long" }]);
  };
  if (scoped) {
    await withProviderCatalogDiscoveryBudget(180_000, run);
  } else {
    await run();
  }
});

it("keeps an immediate row timeout even with a configured provider timeout", async () => {
  clearLiveCatalogCacheForTests();
  const completion = createDeferred<Awaited<ReturnType<LiveModelCatalogFetchGuard>>>();
  const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(() => completion.promise);
  await withProviderCatalogDiscoveryBudget(
    180_000,
    async () => {
      const read = (timeoutMs?: number) =>
        getCachedLiveProviderModelRows({
          providerId: "zero-cap",
          endpoint: "https://zero.example.test/models",
          timeoutMs,
          fetchGuard,
        });
      const long = read();
      const immediate = expect(read(0)).rejects.toThrow("before the catalog completed");
      completion.resolve({
        response: new Response(JSON.stringify({ data: [{ id: "healthy" }] })),
        finalUrl: "https://zero.example.test/models",
        release: async () => undefined,
      });
      await immediate;
      expect(await long).toEqual([{ id: "healthy" }]);
      expect(fetchGuard).toHaveBeenCalledOnce();
    },
    { "zero-cap": 15_000 },
  );
});
