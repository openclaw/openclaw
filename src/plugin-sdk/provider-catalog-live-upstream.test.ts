import { assert, beforeEach, expect, it, vi, type MockedFunction } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withProviderCatalogDiscoveryBudget } from "../plugins/provider-catalog-expiry.js";
import { projectUpstreamProviderCatalogModel as projectUpstream } from "./provider-catalog-live-normalize.internal.js";
import {
  clearLiveCatalogCacheForTests,
  getCachedUpstreamProviderCatalog,
  type LiveModelCatalogFetchGuard,
  type UpstreamProviderCatalog,
  type UpstreamProviderCatalogModel,
} from "./provider-catalog-live-runtime.js";
import { listProviderCatalogSnapshotEntries } from "./provider-catalog-snapshot.internal.js";

const endpoint = "https://models.opencode.ai/api.json";
async function loadProvider(fetchGuard: LiveModelCatalogFetchGuard, providerId = "opencode") {
  return getCachedUpstreamProviderCatalog({ endpoint, providerId, fetchGuard });
}
function makeProvider(
  id = "opencode",
  api = "https://opencode.ai/zen/v1",
  npm?: string,
): UpstreamProviderCatalog {
  return { id, api, npm, models: {} };
}
function project(
  model: UpstreamProviderCatalogModel,
  provider = makeProvider(),
  defaultBaseUrl?: string,
) {
  return projectUpstream({ providerId: provider.id, provider, model, defaultBaseUrl });
}

function buildFetchGuard(body: unknown) {
  const release = vi.fn(async () => undefined);
  const fetchGuard: MockedFunction<LiveModelCatalogFetchGuard> = vi.fn(async () => ({
    response: new Response(JSON.stringify(body)),
    finalUrl: endpoint,
    release,
  }));
  return { fetchGuard, release };
}

async function fetchedModel(
  model: UpstreamProviderCatalogModel,
  metadata = makeProvider("opencode", "https://opencode.ai/zen/v1", "@ai-sdk/openai-compatible"),
) {
  assert(model);
  const { fetchGuard } = buildFetchGuard({
    [metadata.id]: { ...metadata, models: { [model.id]: model } },
  });
  const provider = await loadProvider(fetchGuard, metadata.id);
  assert(provider, "expected upstream provider");
  const upstreamModel = provider.models[model.id];
  assert(upstreamModel, "expected upstream provider model");
  return project(upstreamModel, provider);
}

beforeEach(() => clearLiveCatalogCacheForTests());

it("lazily shares one anonymous upstream metadata download across provider ids", async () => {
  const { fetchGuard, release } = buildFetchGuard({
    opencode: { id: "opencode", api: "https://opencode.ai/zen/v1", models: {} },
    "opencode-go": { id: "opencode-go", api: "https://opencode.ai/zen/go/v1", models: {} },
  });

  expect(fetchGuard).not.toHaveBeenCalled();
  const providers = await Promise.all(
    ["missing", "opencode", "opencode-go"].map((id) => loadProvider(fetchGuard, id)),
  );

  const ids = providers.map((provider) => provider?.id);
  expect(ids).toEqual([undefined, "opencode", "opencode-go"]);
  expect(fetchGuard).toHaveBeenCalledTimes(1);
  expect(fetchGuard.mock.calls[0]?.[0]).toMatchObject({
    url: endpoint,
    requireHttps: true,
    auditContext: "upstream-provider-catalog-discovery",
  });
  expect(fetchGuard.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
  expect(fetchGuard.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(15_000);
  expect(new Headers(fetchGuard.mock.calls[0]?.[0].init?.headers).get("authorization")).toBeNull();
  expect(release).toHaveBeenCalledTimes(1);
});

it.each([4, 8])(
  "bounds a %i MiB shared feed with its separate eight-megabyte ceiling",
  async (size) => {
    const { fetchGuard, release } = buildFetchGuard({
      padding: "x".repeat(size * 1024 * 1024),
      opencode: { id: "opencode", models: {} },
    });
    const loaded = loadProvider(fetchGuard);
    if (size === 4) {
      await expect(loaded).resolves.toMatchObject({ id: "opencode" });
    } else {
      await expect(loaded).rejects.toThrow("Live model catalog response exceeded 8388608 bytes");
    }
    expect(release).toHaveBeenCalledTimes(1);
  },
);

it("projects pricing, reasoning, tools, and modalities from object tiers JSON", async () => {
  const model = await fetchedModel(
    {
      id: "frontier-model",
      name: "Frontier Model",
      parameterCount: 4_000_000_000,
      reasoning: true,
      tool_call: true,
      reasoning_options: [{ type: "effort", values: ["low", "high", "high", false] }],
      modalities: { input: ["text", "image", "video"] },
      provider: { npm: "@ai-sdk/openai" },
      limit: { context: 1_000_000, input: 900_000, output: 128_000 },
      cost: { input: 2, output: 6, cache_read: 0.5, cache_write: 1, tiers: {} },
    },
    makeProvider("opencode-go", "https://opencode.ai/zen/go/v1", "@ai-sdk/openai-compatible"),
  );

  expect(model).toEqual({
    id: "frontier-model",
    name: "Frontier Model",
    parameterCount: 4_000_000_000,
    provider: "opencode-go",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    contextTokens: 900_000,
    maxTokens: 128_000,
    thinkingLevelMap: { off: null },
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 1 },
    compat: {
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      supportsTools: true,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "high"],
    },
  });
  assert(model, "expected projected upstream model");
  const snapshot = new Map([[model.id, { model }]]);
  expect(listProviderCatalogSnapshotEntries(snapshot)[0]?.parameterCount).toBe(4_000_000_000);
});

it.each([
  { name: "empty", options: [], efforts: [] },
  {
    name: "native null effort",
    options: [{ type: "effort", values: [null, "high", null, "VendorExact"] }],
    efforts: ["none", "high", "VendorExact"],
  },
])("preserves $name upstream reasoning controls", ({ options, efforts }) => {
  for (const npm of ["@ai-sdk/openai-compatible", "@ai-sdk/openai"]) {
    const provider = makeProvider("fixture-provider", "https://models.example.test/v1", npm);
    const model = project(
      {
        id: "reasoning-fixture",
        reasoning: true,
        limit: { context: 128_000, output: 8192 },
        reasoning_options: options,
      },
      provider,
    );

    expect(model).toMatchObject({
      reasoning: true,
      compat: {
        supportsReasoningEffort: efforts.length > 0,
        supportedReasoningEfforts: efforts,
      },
    });
    expect(model).not.toHaveProperty("thinkingLevelMap");
  }
});

it.each([
  ["@ai-sdk/anthropic", "anthropic-messages", "https://opencode.ai/zen"],
  ["constructor", undefined, undefined],
] as const)(
  "projects only supported upstream %s transport from JSON",
  async (npm, api, baseUrl) => {
    const model = await fetchedModel({
      id: "opaque-preview-id",
      name: "Opaque Preview",
      provider: { npm },
      limit: { context: 128_000, output: 8192 },
    });

    if (api === undefined) {
      expect(model).toBeUndefined();
    } else {
      expect(model).toMatchObject({ api, baseUrl });
    }
  },
);

it("rejects upstream metadata that would redirect authenticated inference to another origin", () => {
  const provider = makeProvider();
  const model = {
    id: "opaque-preview-id",
    name: "Opaque Preview",
    limit: { context: 128_000, output: 8192 },
  };

  expect(
    project({ ...model, provider: { api: "https://attacker.example/v1" } }, provider),
  ).toBeUndefined();
  expect(
    project(
      model,
      { ...provider, api: "https://attacker.example/v1" },
      "https://opencode.ai/zen/v1",
    ),
  ).toBeUndefined();
});

it.each([
  [undefined, 180_000],
  [2_000, 2_000],
  [0, 180_000],
])("caps a shared feed by its acquisition and explicit cap %s", async (timeoutMs, cap) => {
  const { fetchGuard } = buildFetchGuard({ opencode: makeProvider() });
  await withProviderCatalogDiscoveryBudget(180_000, () =>
    getCachedUpstreamProviderCatalog({ endpoint, providerId: "opencode", timeoutMs, fetchGuard }),
  );
  const admitted = fetchGuard.mock.calls[0]?.[0].timeoutMs;
  expect(admitted).toBeGreaterThan(cap - 1_000);
  expect(admitted).toBeLessThanOrEqual(cap);
});

it("preserves a standalone feed's zero timer without sharing a finite pending load", async () => {
  const unscoped = createDeferred<Awaited<ReturnType<LiveModelCatalogFetchGuard>>>();
  const finite = createDeferred<Awaited<ReturnType<LiveModelCatalogFetchGuard>>>();
  const fetchGuard = vi
    .fn<LiveModelCatalogFetchGuard>()
    .mockImplementationOnce(() => unscoped.promise)
    .mockImplementationOnce(() => finite.promise);
  const read = (timeoutMs: number) =>
    getCachedUpstreamProviderCatalog({
      endpoint,
      providerId: "opencode",
      timeoutMs,
      fetchGuard,
    });
  const noTimer = read(0);
  const bounded = read(5_000);
  try {
    expect(fetchGuard).toHaveBeenCalledTimes(2);
    expect(fetchGuard.mock.calls[0]?.[0].timeoutMs).toBe(0);
    expect(fetchGuard.mock.calls[1]?.[0].timeoutMs).toBeGreaterThan(0);
    expect(fetchGuard.mock.calls[1]?.[0].timeoutMs).toBeLessThanOrEqual(5_000);
  } finally {
    const response = () => ({
      response: new Response(JSON.stringify({ opencode: makeProvider() })),
      finalUrl: endpoint,
      release: async () => undefined,
    });
    unscoped.resolve(response());
    finite.resolve(response());
  }
  expect(await noTimer).toMatchObject({ id: "opencode" });
  expect(await bounded).toMatchObject({ id: "opencode" });
});
