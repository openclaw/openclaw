import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi, type MockedFunction } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./provider-auth-runtime.js";
import {
  buildLiveModelProviderConfig as buildLiveProvider,
  buildOpenAICompatibleLiveModelProviderConfig as buildCompatibleProvider,
  buildOpenAICompatibleLiveProviderCatalog as buildCatalog,
  buildOpenAICompatibleProviderFamilyCatalog as buildFamily,
  clearLiveCatalogCacheForTests,
  fetchLiveProviderModelIds,
  LiveModelCatalogHttpError,
  readLiveModelCatalogStringField,
  type LiveModelCatalogFetchGuard as FetchGuard,
} from "./provider-catalog-live-runtime.js";
import type { ProviderCatalogContext } from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./provider-model-shared.js";
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

const catalogEndpoint = "https://provider.example.test/v1/models";
const defaultProvider = {
  api: "openai-completions" as const,
  baseUrl: "https://provider.example.test/v1",
};

function providerConfig(
  models: ModelDefinitionConfig[] = [],
  overrides: Partial<ModelProviderConfig> = {},
): ModelProviderConfig {
  return { ...defaultProvider, models, ...overrides };
}
const request = (mock: MockedFunction<FetchGuard>, index = 0) => mock.mock.calls[index]?.[0];

function guardedResponse(
  body: unknown,
  finalUrl = catalogEndpoint,
  release = vi.fn(async () => undefined),
) {
  return {
    response: body instanceof Response ? body : new Response(JSON.stringify(body)),
    finalUrl,
    release,
  };
}

function fetchIds(
  fetchGuard: FetchGuard,
  params: Partial<Parameters<typeof fetchLiveProviderModelIds>[0]> = {},
) {
  return fetchLiveProviderModelIds({
    providerId: "provider",
    endpoint: catalogEndpoint,
    fetchGuard,
    ...params,
  });
}

function liveProvider(
  fetchGuard: FetchGuard,
  models: ModelDefinitionConfig[],
  extra: Partial<Parameters<typeof buildLiveProvider>[0]> = {},
) {
  return buildLiveProvider({
    providerId: "provider",
    endpoint: catalogEndpoint,
    providerConfig: defaultProvider,
    fetchGuard,
    models,
    ...extra,
  });
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  object: "model",
  ...extra,
});
function expectHeaders(
  mock: MockedFunction<FetchGuard>,
  values: Record<string, string | null>,
  index = 0,
) {
  const headers = request(mock, index)?.init?.headers;
  expect(headers).toBeInstanceOf(Headers);
  expect(
    Object.fromEntries(Object.keys(values).map((key) => [key, new Headers(headers).get(key)])),
  ).toEqual(values);
}

function buildFetchGuard(body: unknown) {
  const release = vi.fn(async () => undefined);
  const fetchGuard: MockedFunction<FetchGuard> = vi.fn(async () =>
    guardedResponse(body, catalogEndpoint, release),
  );
  return { fetchGuard, release };
}

function streamingGuard(source: UnderlyingSource<Uint8Array>) {
  return buildFetchGuard(
    new Response(new ReadableStream(source), { headers: { "content-type": "application/json" } }),
  );
}
function familyEntry(id: string, label: string) {
  const buildProvider = vi.fn(() => ({
    baseUrl: "not-a-url",
    api: "openai-completions" as const,
    models: [],
  }));
  return { id, label, baseUrl: "not-a-url", models: [], buildProvider };
}

it("retains raw id identities for read-time diagnostics before chat filtering", async () => {
  const { fetchGuard } = buildFetchGuard({
    data: [row("chat-local"), row("local/chat-local"), { id: "embed-local", object: "embedding" }],
  });
  const result = await buildCatalog({
    providerId: "local",
    discoveryMode: "strict",
    fetchGuard,
    providerConfig: providerConfig([], { baseUrl: "http://127.0.0.1:1234/v1" }),
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
  expect(fetchGuard).toHaveBeenCalledOnce();
});

beforeEach(clearLiveCatalogCacheForTests);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("fetches and dedupes live model ids with opaque resolved auth", async () => {
  const discoveryApiKey = NON_ENV_SECRETREF_MARKER;
  const { fetchGuard, release } = buildFetchGuard({
    data: [
      row("model-a"),
      row("model-b"),
      { id: "embedding-a", object: "embedding" },
      row("model-a"),
    ],
  });
  const controller = new AbortController();

  await expect(
    fetchIds(fetchGuard, {
      apiKey: NON_ENV_SECRETREF_MARKER,
      discoveryApiKey,
      signal: controller.signal,
      timeoutMs: 1234,
    }),
  ).resolves.toEqual(["model-a", "model-b"]);

  expect(fetchGuard).toHaveBeenCalledTimes(1);
  const captured = request(fetchGuard);
  expect(captured).toMatchObject({
    url: "https://provider.example.test/v1/models",
    auditContext: "provider-model-discovery",
    signal: controller.signal,
  });
  expect(captured?.timeoutMs).toBeGreaterThan(0);
  expect(captured?.timeoutMs).toBeLessThanOrEqual(1234);
  expect(Number.isInteger(captured?.timeoutMs)).toBe(true);
  expectHeaders(fetchGuard, { authorization: `Bearer ${discoveryApiKey}` });
  expect(release).toHaveBeenCalledTimes(1);
});

it("does not send non-secret SecretRef markers as live catalog bearer tokens", async () => {
  const { fetchGuard } = buildFetchGuard({ data: [] });
  const buildRequestHeaders = vi.fn(({ apiKey, discoveryApiKey }) => ({
    Accept: "application/json",
    ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
    ...(apiKey ? { "X-Api-Key": apiKey } : {}),
  }));

  await expect(
    fetchIds(fetchGuard, { apiKey: NON_ENV_SECRETREF_MARKER, buildRequestHeaders }),
  ).resolves.toEqual([]);

  expect(buildRequestHeaders).toHaveBeenCalledWith({
    apiKey: undefined,
    discoveryApiKey: undefined,
  });
  expectHeaders(fetchGuard, { authorization: null, "x-api-key": null });
});

it("contextualizes paginated malformed JSON through the guarded network path", async () => {
  const credential = "reflected-fake-network-credential";
  let requests = 0;
  const server = createServer((incoming, response) => {
    requests += 1;
    expect(incoming.headers.authorization).toBe(`Bearer ${credential}`);
    response.setHeader("content-type", "application/json");
    response.end(
      requests === 1
        ? JSON.stringify({ data: [row("model-a")], next: "/models?page=2" })
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
  const fetchGuard: FetchGuard = async (params) =>
    await fetchWithSsrFGuard({ ...params, dispatcherPolicy: { mode: "direct" } });

  try {
    const error = await fetchLiveProviderModelIds({
      providerId: "provider",
      endpoint,
      apiKey: credential,
      fetchGuard,
      policy: { allowPrivateNetwork: true, allowedOrigins: [new URL(endpoint).origin] },
      requireHttps: false,
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ message: "provider model discovery: malformed JSON response" });
    expect(String((error as Error).cause)).not.toContain(credential);
    expect(requests).toBe(2);
  } finally {
    await promisify(server.close.bind(server))();
  }
});

it("does not re-add credentials to redirected-origin pagination requests", async () => {
  const release = vi.fn(async () => undefined);
  const fetchGuard: MockedFunction<FetchGuard> = vi
    .fn()
    .mockResolvedValueOnce(
      guardedResponse(
        { data: [row("model-a")], links: { next: "?page=2" } },
        "https://redirected.example.test/v1/models/",
        release,
      ),
    )
    .mockResolvedValueOnce(
      guardedResponse(
        { data: [row("model-b")] },
        "https://redirected.example.test/v1/models/?page=2",
        release,
      ),
    );

  await expect(
    fetchIds(fetchGuard, {
      discoveryApiKey: "provider-token",
      buildRequestHeaders: ({ discoveryApiKey }) => ({
        Accept: "application/json",
        ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
        "ChatGPT-Account-ID": "acct-1",
      }),
    }),
  ).resolves.toEqual(["model-a", "model-b"]);

  expectHeaders(fetchGuard, {
    authorization: "Bearer provider-token",
    "chatgpt-account-id": "acct-1",
  });
  expect(request(fetchGuard, 1)?.url).toBe("https://redirected.example.test/v1/models/?page=2");
  expectHeaders(
    fetchGuard,
    { authorization: null, "chatgpt-account-id": null, accept: "application/json" },
    1,
  );
});

it.each([
  {
    name: "truncated",
    count: 50,
    page(url: string) {
      const page = Number(new URL(url).searchParams.get("after") ?? "0");
      return { data: [row("model-" + page)], has_more: true, next_cursor: String(page + 1) };
    },
    message: "provider model discovery exceeded 50 pages before the catalog completed",
  },
  {
    name: "incomplete",
    count: 1,
    page: () => ({ data: [row("model-a")], has_more: true }),
    message:
      "provider model discovery did not include a supported next page before the catalog completed",
  },
])("fails $name pagination instead of returning partial rows", async ({ count, page, message }) => {
  const release = vi.fn(async () => undefined);
  const fetchGuard: MockedFunction<FetchGuard> = vi.fn(async ({ url }) =>
    guardedResponse(page(url), url, release),
  );
  await expect(fetchIds(fetchGuard)).rejects.toThrow(message);
  expect(fetchGuard).toHaveBeenCalledTimes(count);
  expect(release).toHaveBeenCalledTimes(count);
});

it("uses one timeout budget after a 2000 ms wall-clock step", async () => {
  vi.useFakeTimers();
  const release = vi.fn(async () => undefined);
  const fetchGuard: MockedFunction<FetchGuard> = vi
    .fn()
    .mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(800);
      vi.setSystemTime(Date.now() + 2_000);
      return guardedResponse(
        { data: [row("model-a")], has_more: true, next_cursor: "cursor-2" },
        catalogEndpoint,
        release,
      );
    })
    .mockImplementationOnce(async () =>
      guardedResponse({ data: [row("model-b")] }, catalogEndpoint + "?after=cursor-2", release),
    );

  await expect(fetchIds(fetchGuard, { timeoutMs: 1_000 })).resolves.toEqual(["model-a", "model-b"]);

  expect(fetchGuard).toHaveBeenCalledTimes(2);
  expect(request(fetchGuard)?.timeoutMs).toBe(1_000);
  expect(request(fetchGuard, 1)?.timeoutMs).toBe(200);
  expect(release).toHaveBeenCalledTimes(2);
});

it("bounds an unbounded live catalog success stream and cancels the body", async () => {
  const encoder = new TextEncoder();
  let pullCount = 0;
  let cancelled = false;
  const { release, fetchGuard } = streamingGuard({
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
  });

  const error = await fetchIds(fetchGuard).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/Live model catalog response exceeded \d+ bytes/);
  expect(cancelled).toBe(true);
  expect(release).toHaveBeenCalledTimes(1);
});

it("aborts a stalled live catalog success stream", async () => {
  vi.useFakeTimers();
  const encoder = new TextEncoder();
  let cancelReason: unknown;
  const { release, fetchGuard } = streamingGuard({
    start(controller) {
      // Emit a partial JSON prefix and then idle forever without closing.
      controller.enqueue(encoder.encode('[{"id":"model-a",'));
    },
    cancel(reason) {
      cancelReason = reason;
    },
  });

  const resultPromise = fetchIds(fetchGuard, { timeoutMs: 1234 }).catch((err: unknown) => err);

  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1234);
  const error = await resultPromise;

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Live model catalog response stalled: no data received for 1234ms",
  );
  expect(cancelReason).toBeInstanceOf(Error);
  expect(release).toHaveBeenCalledTimes(1);
});

it("throws structured HTTP errors after releasing guarded fetches", async () => {
  const response = new Response("{}", { status: 401 });
  const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
  const { release, fetchGuard } = buildFetchGuard(response);

  const error = await fetchIds(fetchGuard).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(LiveModelCatalogHttpError);
  expect(error).toMatchObject({ status: 401 });
  expect(cancel).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledTimes(1);
});

it("shows every listed chat model, excludes non-chat rows and keeps static rows on failure", async () => {
  const { fetchGuard } = buildFetchGuard([
    row("model-a", { output_modalities: ["image"] }),
    row("model-b"),
    row("unknown-model"),
    row("sunsetting-chat", { shutdown_date: "2999-01-01" }),
    row("vision-chat", { pipeline_tag: "image-text-to-text" }),
    ...[
      "gpt-realtime-2",
      "gpt-audio-mini",
      "grok-2-image",
      "grok-imagine-video",
      "babbage-002",
      "gpt-3.5-turbo-instruct",
    ].map((id) => ({ id, object: "model" })),
    row("retired-chat", { shutdown_date: "2000-01-01" }),
  ]);
  const models = [buildModel("model-a"), buildModel("model-b")];
  const buildProvider = () =>
    liveProvider(fetchGuard, models, {
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      ttlMs: 60_000,
    });
  const first = await buildProvider();
  const second = await buildProvider();

  expect(fetchGuard).toHaveBeenCalledTimes(1);
  expect(first.apiKey).toBe("PROVIDER_API_KEY");
  expect(first.models).toEqual([
    models[1],
    expect.objectContaining({ id: "sunsetting-chat" }),
    expect.objectContaining({ id: "unknown-model", input: ["text"], contextWindow: 128_000 }),
    expect.objectContaining({ id: "vision-chat" }),
  ]);
  expect(second.models).toEqual(first.models);

  clearLiveCatalogCacheForTests();
  fetchGuard.mockRejectedValueOnce(new Error("network unavailable"));
  const fallback = await buildProvider();

  expect(fallback.apiKey).toBe("PROVIDER_API_KEY");
  expect(fallback.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
});

it("admits and rejects listed rows through the provider id selector", async () => {
  const { fetchGuard } = buildFetchGuard({
    data: [
      { slug: "model-a" },
      { slug: "fresh-chat" },
      { slug: "fresh-embedding" },
      row("model-b"),
    ],
  });
  const models = [buildModel("model-a"), buildModel("model-b")];

  const provider = await liveProvider(fetchGuard, models, {
    discoveryMode: "strict",
    readModelId: (entry) => readLiveModelCatalogStringField(entry, "slug"),
  });

  expect(provider.models).toEqual([
    expect.objectContaining({ id: "fresh-chat", input: ["text"] }),
    models[0],
  ]);
});

it("builds newly listed text models from OpenAI-compatible catalog metadata", async () => {
  const { fetchGuard } = buildFetchGuard({
    data: [
      row("chat-v2", {
        active: true,
        context_window: 262_144,
        max_completion_tokens: 32_768,
        input_modalities: ["text", "image"],
        features: ["reasoning"],
      }),
      row("text-embedding-4"),
      row("gpt-image-2-oai"),
      row("retired-chat", { active: false }),
      row("archived-chat", { archived: true }),
      row("deprecated-chat", { deprecated: true }),
      row("fim-only", { capabilities: { completion_chat: false, completion_fim: true } }),
      row("image-generation-v2", { features: ["image_generation"] }),
      row("chat-and-image-v2", {
        capabilities: { completion_chat: true },
        features: ["image_generation"],
      }),
      row("image-only", { output_modalities: ["image"] }),
    ],
  });

  const provider = await buildCompatibleProvider({
    providerId: "provider",
    providerConfig: providerConfig([buildModel("chat-v1")], {
      baseUrl: "https://provider.example.test/v1/",
    }),
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
  expect(request(fetchGuard)?.url).toBe("https://provider.example.test/v1/models");
  expectHeaders(fetchGuard, { authorization: "Bearer provider-key" });
});

it("supports provider-specific model-list paths and headers", async () => {
  const { fetchGuard } = buildFetchGuard({ data: [row("claude-next")] });

  await buildCompatibleProvider({
    providerId: "anthropic-style",
    providerConfig: providerConfig([buildModel("claude-current")], {
      api: "anthropic-messages",
      baseUrl: "https://provider.example.test",
    }),
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

  expect(request(fetchGuard)?.url).toBe("https://provider.example.test/v1/models");
  expectHeaders(fetchGuard, { "x-api-key": "provider-key", "anthropic-version": "2023-06-01" });
});

it("does not send credentials to a fixed discovery endpoint after a base URL override", async () => {
  const fetchGuard: MockedFunction<FetchGuard> = vi.fn();
  const proxy = providerConfig([buildModel("chat-current")], {
    baseUrl: "https://private-proxy.example.test/v1",
  });

  await expect(
    buildCompatibleProvider({
      providerId: "provider",
      providerConfig: proxy,
      apiKey: "private-proxy-key",
      modelDiscovery: {
        endpointUrl: {
          url: "https://provider.example.test/v1/models",
          requireBaseUrl: "https://provider.example.test/v1",
        },
      },
      fetchGuard,
    }),
  ).resolves.toEqual({ ...proxy, apiKey: "private-proxy-key" });

  expect(fetchGuard).not.toHaveBeenCalled();
});

it("scopes shared family credentials and construction to selected entries", async () => {
  const primary = familyEntry("family", "Family");
  const plan = familyEntry("family-plan", "Family Plan");
  const family = buildFamily({
    credentialProviderId: "family",
    entries: [primary, plan],
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
  expect(primary.buildProvider).not.toHaveBeenCalled();
  expect(plan.buildProvider).toHaveBeenCalledOnce();

  resolveProviderApiKey.mockClear();
  await expect(family.catalog.run({ ...context, providerIds: ["other"] })).resolves.toBeNull();
  expect(resolveProviderApiKey).not.toHaveBeenCalled();
});
