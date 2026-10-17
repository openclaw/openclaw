import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RemoteModelCatalogBundle } from "@openclaw/model-catalog-core";
import {
  LITELLM_PRICING_URL,
  MODELS_DEV_CATALOG_URL,
  OPENROUTER_MODELS_URL,
} from "@openclaw/model-catalog-core/model-catalog-pricing";
import { afterEach, expect, it, vi } from "vitest";
import {
  assembleModelCatalogBundle,
  assembleModelCatalogBundleV2,
  enrichModelCatalogPricing,
  hydrateModelCatalogFromModelsDev,
  parsePublishModelCatalogArgs,
  readModelCatalogManifests,
  resolveProviderFeaturedModels,
  retireUnservedModels,
  serializeModelCatalogBundle,
  summarizeModelCatalogBundle,
} from "../../scripts/publish-model-catalog.mts";
import { MODELS_JSON_STATE } from "../../src/agents/models-config-state.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { prepareRemoteModelCatalogStartupSnapshot } from "../../src/model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../../src/model-catalog/remote-overlay.test-support.js";
import { resolveModelCostConfig } from "../../src/utils/usage-format.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  setRemoteModelCatalogOverlaySourcesForTest();
  MODELS_JSON_STATE.costCache.clear();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function captureWarnings() {
  const messages: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    messages.push(String(value));
    return true;
  });
  return () => messages.join("");
}
type FixtureModel = RemoteModelCatalogBundle["providers"][string]["models"][number];
type Manifest = Parameters<typeof assembleModelCatalogBundle>[0]["manifests"][number]["manifest"];
function manifestEntry(pluginId: string, manifest: Manifest) {
  return { pluginId, manifestPath: `${pluginId}.json`, manifest };
}
function routerModel(
  id: string,
  prompt: string,
  completion: string,
  extra: Record<string, unknown> = {},
) {
  return { id, pricing: { prompt, completion, ...extra } };
}
function deepInfraModel(
  model_name: string,
  input: number,
  output: number,
  extra: Record<string, unknown> = {},
) {
  return {
    model_name,
    pricing: {
      type: "tokens",
      cents_per_input_token: input,
      cents_per_output_token: output,
      ...extra,
    },
  };
}
function tier(input: number, output: number, range: number[]) {
  return { input_cost_per_token: input, output_cost_per_token: output, range };
}
function liteLLMPrice(provider: string, input: number, output: number) {
  return { litellm_provider: provider, input_cost_per_token: input, output_cost_per_token: output };
}

function fixtureProvider(prefix: string, count: number): { models: FixtureModel[] } {
  return { models: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` })) };
}

function fixtureManifests(
  providers: Record<string, unknown> = {},
  catalog: NonNullable<Manifest["modelCatalog"]> = {},
  owned = true,
) {
  const allProviders = {
    anthropic: fixtureProvider("claude", 100),
    openai: fixtureProvider("gpt", 100),
    ...providers,
  };
  return [
    manifestEntry("fixture", {
      ...(owned ? { providers: Object.keys(allProviders) } : {}),
      modelCatalog: { providers: allProviders, ...catalog },
    }),
  ];
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

type ModelsDevFixtureModel = { id: string } & Record<string, unknown>;

function modelsDevModel(
  id: string,
  overrides: Record<string, unknown> = {},
): ModelsDevFixtureModel {
  return {
    id,
    name: `Feed ${id}`,
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 128000, output: 32000 },
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
    ...overrides,
  };
}

function modelsDevCatalog(
  providers: Record<string, ModelsDevFixtureModel[]>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(providers).map(([id, models]) => [
      id,
      { id, models: Object.fromEntries(models.map((model) => [model.id, model])) },
    ]),
  );
}

async function publishedPricingParams(bundle: RemoteModelCatalogBundle, provider: string) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-native-pricing-"));
  tempDirs.push(agentDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 1,
    readStoredCatalog: () => ({
      id: 1,
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
      bundle_json: serializeModelCatalogBundle(bundle),
      generated_at: bundle.generatedAt,
      min_version: bundle.minVersion ?? null,
      etag: null,
      last_modified: null,
      checked_at: bundle.generatedAt,
    }),
  });
  // These bundles are v1 output; clients read v1 only from a configured mirror.
  const config: OpenClawConfig = {
    models: { catalogRefresh: { url: "https://catalog.openclaw.ai/models/v1/catalog.json" } },
    plugins: { allow: [provider], entries: { [provider]: { enabled: true } } },
  };
  await prepareRemoteModelCatalogStartupSnapshot();
  return { config, agentDir, provider };
}

function writeFixtureManifest(root: string, pluginId: string, providers: Record<string, unknown>) {
  const pluginDir = path.join(root, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId, modelCatalog: { providers } }, null, 2)}\n`,
  );
}

function assembleFixtureBundle(
  manifests: Parameters<typeof assembleModelCatalogBundle>[0]["manifests"],
) {
  return assembleModelCatalogBundle({
    manifests,
    generatedAt: Date.now(),
    sourceCommit: "fixture",
  });
}

async function catalogFixture(manifests: Parameters<typeof assembleFixtureBundle>[0]) {
  const bundle = await assembleFixtureBundle(manifests);
  return {
    bundle,
    hydrate: (fetchImpl: typeof fetch) =>
      hydrateModelCatalogFromModelsDev({ bundle, manifests, fetchImpl }),
    enrich: (fetchImpl: typeof fetch) =>
      enrichModelCatalogPricing({ bundle, manifests, fetchImpl }),
  };
}

function nativeManifests(source: "OpenCode" | "Venice" | "DeepInfra") {
  const provider = source.toLowerCase();
  const sourceId = source === "OpenCode" ? "openCode" : provider;
  const manifests = fixtureManifests({
    [provider]: { models: [{ id: "priced-fixture", cost: { input: 99, output: 99 } }] },
  });
  manifests[0]!.manifest.modelPricing = {
    providers: {
      [provider]: {
        external: true,
        [sourceId]: { provider: source === "OpenCode" ? "upstream-zen" : provider },
        openRouter: { provider },
        liteLLM: { provider },
      },
    },
  };
  return manifests;
}

function openCodePrices(
  cost: Record<string, unknown>,
  ids = ["priced-fixture", "new-priced-fixture"],
) {
  return {
    "upstream-zen": {
      id: "upstream-zen",
      models: Object.fromEntries(ids.map((id) => [id, { id, cost }])),
    },
  };
}

const OPENCODE_PRICING_URL = "https://models.opencode.ai/api.json";
const VENICE_PRICING_URL = "https://api.venice.ai/api/v1/models";

it("uses DeepInfra native discounts, not generic rates", async () => {
  const manifests = nativeManifests("DeepInfra");
  const { bundle, enrich } = await catalogFixture(manifests);
  const provider = bundle.providers.deepinfra!;
  for (const id of ["qualified", "absent", "free"]) {
    provider.models.push({
      ...provider.models[0]!,
      id,
      name: `Fixture ${id}`,
      contextWindow: 123456,
    });
  }
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    const url = requestUrl(input);
    if (url === "https://api.deepinfra.com/models/list") {
      return Response.json([
        deepInfraModel("priced-fixture", 0.0002, 0.001, {
          discount: 0.5,
          rate_per_input_token_cached: 0.2,
        }),
        deepInfraModel("qualified", 0.0002, 0.001, { full: "Higher rates at long context" }),
        ...["free", "standalone-free", "foreign/hidden"].map((id) => deepInfraModel(id, 0, 0)),
      ]);
    }
    if (url === OPENROUTER_MODELS_URL) {
      return Response.json({
        data: ["priced-fixture", "qualified", "absent", "absent-unbundled"].map((id) =>
          routerModel(`deepinfra/${id}`, "1", "1"),
        ),
      });
    }
    if (url === MODELS_DEV_CATALOG_URL) {
      return Response.json({});
    }
    expect(url).toBe(LITELLM_PRICING_URL);
    return Response.json({
      absent: liteLLMPrice("deepinfra", 1, 1),
    });
  });
  await enrich(fetchImpl);
  expect(bundle.providers.deepinfra?.models[0]?.cost).toEqual({
    input: 1,
    output: 5,
    cacheRead: 0.2,
    cacheWrite: 0,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  for (const id of ["qualified", "absent"]) {
    const model = bundle.providers.deepinfra?.models.find((row) => row.id === id);
    expect(model).toMatchObject({ name: `Fixture ${id}`, contextWindow: 123456 });
    expect(model?.cost).toBeUndefined();
  }
  expect(bundle.pricing).toEqual({
    "deepinfra/free": { input: 0, output: 0 },
    "deepinfra/standalone-free": { input: 0, output: 0 },
  });
  expect(bundle.providers).not.toHaveProperty("foreign");
  const params = await publishedPricingParams(bundle, "deepinfra");
  for (const model of ["free", "standalone-free"]) {
    expect(resolveModelCostConfig({ ...params, model })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }
  expect(resolveModelCostConfig({ ...params, model: "qualified" })).toBeUndefined();
});

it("rejects DeepInfra objects without mutating the bundle", async () => {
  const manifests = nativeManifests("DeepInfra");
  const { bundle, enrich } = await catalogFixture(manifests);
  const previous = serializeModelCatalogBundle(bundle);
  await expect(
    enrich(async (input) => {
      const url = requestUrl(input);
      if (url === "https://api.deepinfra.com/models/list") {
        return Response.json({ data: [] });
      }
      return Response.json(url === OPENROUTER_MODELS_URL ? { data: [] } : {});
    }),
  ).rejects.toThrow("DeepInfra pricing");
  expect(serializeModelCatalogBundle(bundle)).toBe(previous);
});

it("assembles and validates fixture manifests at the 200-model floor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-catalog-"));
  tempDirs.push(root);
  writeFixtureManifest(root, "anthropic", { anthropic: fixtureProvider("claude", 100) });
  writeFixtureManifest(root, "openai", { openai: fixtureProvider("gpt", 100) });

  const bundle = await assembleFixtureBundle(readModelCatalogManifests({ rootDir: root }));
  expect(summarizeModelCatalogBundle(bundle)).toEqual({
    providers: 2,
    models: 200,
    costModels: 0,
    pricingEntries: 0,
  });
});

it("omits empty static catalogs owned by runtime discovery", async () => {
  const bundle = await assembleFixtureBundle(
    fixtureManifests({ "claude-cli": { models: [] } }, {}, false),
  );
  expect(bundle.providers).not.toHaveProperty("claude-cli");
  expect(summarizeModelCatalogBundle(bundle)).toMatchObject({ providers: 2, models: 200 });
});

it.each([
  { providers: { anthropic: fixtureProvider("claude", 200) }, error: "anthropic and openai" },
  {
    providers: { anthropic: fixtureProvider("claude", 100), openai: fixtureProvider("gpt", 99) },
    error: "below required floor 200",
  },
  {
    providers: {
      anthropic: fixtureProvider("claude", 100),
      openai: { models: [{ id: "" }, ...fixtureProvider("gpt", 100).models] },
    },
    error: undefined,
  },
])("rejects incomplete or invalid provider rows: $error", async ({ providers, error }) => {
  await expect(
    assembleFixtureBundle([manifestEntry("fixture", { modelCatalog: { providers } })]),
  ).rejects.toThrow(error);
});

it("hydrates missing models without replacing manifest metadata", async () => {
  const anthropic = fixtureProvider("claude", 100);
  const manifestOwned: FixtureModel = {
    id: "manifest-owned",
    name: "Manifest name",
    reasoning: false,
    input: ["text"],
    contextWindow: 999,
    maxTokens: 888,
  };
  anthropic.models[0] = structuredClone(manifestOwned);
  anthropic.models[1] = { id: "manifest-partial" };
  const manifests = fixtureManifests(
    { anthropic },
    { modelsDev: { anthropic: "upstream-anthropic" } },
  );
  const { bundle, hydrate } = await catalogFixture(manifests);
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    expect(requestUrl(input)).toBe(MODELS_DEV_CATALOG_URL);
    return Response.json(
      modelsDevCatalog({
        "upstream-anthropic": [
          modelsDevModel("manifest-owned", { name: "Feed name" }),
          modelsDevModel("manifest-partial"),
          modelsDevModel("new-model"),
        ],
      }),
    );
  });

  await expect(hydrate(fetchImpl)).resolves.toEqual({
    anthropic: { added: 1, filled: 1, skipped: 0 },
  });
  const models = bundle.providers.anthropic?.models ?? [];
  expect(models[0]?.id).toBe("manifest-owned");
  expect(models[1]?.id).toBe("manifest-partial");
  expect(models.find((model) => model.id === "manifest-owned")).toEqual(manifestOwned);
  for (const id of ["manifest-partial", "new-model"]) {
    expect(models.find((model) => model.id === id)).toEqual({
      id,
      name: `Feed ${id}`,
      reasoning: true,
      input: ["text", "image", "document"],
      contextWindow: 128000,
      maxTokens: 32000,
    });
  }
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("filters non-chat, suppressed and unmapped feed rows", async () => {
  const manifests = [
    ...fixtureManifests(
      { featherless: { models: [{ id: "existing-featherless" }] } },
      {
        modelsDev: { openai: "openai" },
        suppressions: [
          { provider: "openai", model: "suppressed-model" },
          {
            provider: "openai",
            model: "endpoint-model",
            when: { baseUrlHosts: ["api.openai.example"] },
          },
        ],
      },
    ),
    manifestEntry("unrelated", {
      providers: [],
      modelCatalog: { suppressions: [{ provider: "openai", model: "allowed-model" }] },
    }),
  ];
  const { bundle, hydrate } = await catalogFixture(manifests);
  const result = await hydrate(async (input) => {
    expect(requestUrl(input)).toBe(MODELS_DEV_CATALOG_URL);
    return Response.json(
      modelsDevCatalog({
        openai: [
          modelsDevModel("image-model", { modalities: { input: ["text"], output: ["image"] } }),
          modelsDevModel("embedding-model", { tool_call: false }),
          modelsDevModel("suppressed-model"),
          modelsDevModel("endpoint-model"),
          modelsDevModel("deprecated-model", { status: "deprecated" }),
          { id: "malformed-model" },
          modelsDevModel("allowed-model"),
        ],
        featherless: [modelsDevModel("feed-model")],
      }),
    );
  });
  expect(result.openai).toEqual({ added: 2, filled: 0, skipped: 5 });
  expect(bundle.providers.openai?.models.map((model) => model.id)).toEqual([
    ...fixtureProvider("gpt", 100).models.map((model) => model.id),
    "endpoint-model",
    "allowed-model",
  ]);
  expect(bundle.providers.featherless?.models.map((model) => model.id)).toEqual([
    "existing-featherless",
  ]);
});

it("skips providers whose manifest rows pick a transport per model", async () => {
  const anthropic = fixtureProvider("claude", 100);
  anthropic.models[0] = { id: "manifest-anthropic", api: "anthropic-messages" };
  const manifests = fixtureManifests({ anthropic }, { modelsDev: { anthropic: "anthropic" } });
  const { bundle, hydrate } = await catalogFixture(manifests);
  const previous = serializeModelCatalogBundle(bundle);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const result = await hydrate(async () =>
    Response.json(modelsDevCatalog({ anthropic: [modelsDevModel("new-model")] })),
  );
  expect(result.anthropic).toBeUndefined();
  expect(serializeModelCatalogBundle(bundle)).toBe(previous);
});

it("rejects models.dev malformed feed before changing the bundle", async () => {
  const manifests = fixtureManifests({}, { modelsDev: { anthropic: "anthropic" } });
  const { bundle, hydrate } = await catalogFixture(manifests);
  const previous = serializeModelCatalogBundle(bundle);
  await expect(
    hydrate(async () => {
      return Response.json([]);
    }),
  ).rejects.toThrow("models.dev");
  expect(serializeModelCatalogBundle(bundle)).toBe(previous);
});

it.each([
  { paddingMiB: 6, outcome: "accepts" },
  { paddingMiB: 40, outcome: "rejects" },
])("$outcome a models.dev feed padded by $paddingMiB MiB", async ({ paddingMiB, outcome }) => {
  const manifests = fixtureManifests({}, { modelsDev: { anthropic: "anthropic" } });
  const { hydrate } = await catalogFixture(manifests);
  const encoder = new TextEncoder();
  const feed = encoder.encode(
    JSON.stringify(modelsDevCatalog({ anthropic: [modelsDevModel("new-model")] })),
  );
  // JSON whitespace keeps the padded feed valid; no content-length forces the streamed bound.
  const padding = encoder.encode(" ".repeat(1024 * 1024));
  let sent = -1;
  const hydration = hydrate(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent === paddingMiB) {
              controller.close();
              return;
            }
            controller.enqueue(sent === -1 ? feed : padding);
            sent += 1;
          },
        }),
      ),
  );
  if (outcome === "accepts") {
    await expect(hydration).resolves.toEqual({
      anthropic: { added: 1, filled: 0, skipped: 0 },
    });
  } else {
    await expect(hydration).rejects.toThrow("models.dev response exceeds 33554432 bytes");
    expect(sent).toBeLessThan(paddingMiB);
  }
});

it("keeps authored rows when an upstream provider disappears", async () => {
  const manifests = fixtureManifests(
    {},
    {
      modelsDev: { anthropic: "anthropic", openai: "renamed-upstream" },
    },
  );
  const { bundle, hydrate } = await catalogFixture(manifests);
  const openaiBefore = JSON.stringify(bundle.providers.openai);
  const warnings = captureWarnings();
  const result = await hydrate(async () =>
    Response.json(modelsDevCatalog({ anthropic: [modelsDevModel("hydrated-claude")] })),
  );
  expect(result.anthropic).toEqual({ added: 1, filled: 0, skipped: 0 });
  expect(result.openai).toBeUndefined();
  expect(JSON.stringify(bundle.providers.openai)).toBe(openaiBefore);
  expect(bundle.providers.anthropic?.models.map((model) => model.id)).toContain("hydrated-claude");
  expect(warnings()).toContain("renamed-upstream");
});

function inventoryManifests() {
  return fixtureManifests({
    nvidia: {
      models: [
        { id: "z-ai/glm-5.3" },
        { id: "z-ai/glm-5.2" },
        { id: "Z-AI/GLM-5.3-FLASH" },
        { id: "z-ai/glm5", status: "deprecated", statusReason: "authored" },
      ],
    },
    novita: { models: [{ id: "sao10K/l3-70b-euryale-v2.1" }, { id: "qwen/qwen3-max" }] },
  });
}

it("deprecates rows a provider's public inventory no longer lists", async () => {
  const bundle = await assembleFixtureBundle(inventoryManifests());
  const inventories: Record<string, string[]> = {
    "https://integrate.api.nvidia.com/v1/models": ["z-ai/glm-5.3", "z-ai/glm-5.3-flash"],
    "https://api.novita.ai/openai/v1/models": ["Sao10K/L3-70B-Euryale-v2.1"],
  };
  const fetchImpl = vi.fn<typeof fetch>(async (input) =>
    Response.json({ data: (inventories[requestUrl(input)] ?? []).map((id) => ({ id })) }),
  );

  await expect(retireUnservedModels({ bundle, fetchImpl })).resolves.toEqual({
    // NVIDIA ids match exactly, so a case-only difference is not served.
    nvidia: ["z-ai/glm-5.2", "Z-AI/GLM-5.3-FLASH"],
    // Novita's inventory mixes case, so only a case-insensitive miss retires a row.
    novita: ["qwen/qwen3-max"],
  });
  expect(bundle.providers.nvidia?.models).toEqual([
    { id: "z-ai/glm-5.3" },
    ...["z-ai/glm-5.2", "Z-AI/GLM-5.3-FLASH"].map((id) => ({
      id,
      status: "deprecated",
      statusReason: "nvidia no longer lists this model in its public model inventory.",
    })),
    { id: "z-ai/glm5", status: "deprecated", statusReason: "authored" },
  ]);
  expect(bundle.providers.novita?.models[0]).toEqual({ id: "sao10K/l3-70b-euryale-v2.1" });
  expect(fetchImpl.mock.calls.map(([input]) => requestUrl(input)).toSorted()).toEqual(
    Object.keys(inventories).toSorted(),
  );
});

it.each([
  ["unavailable", () => new Response("Gone.", { status: 404 })],
  ["malformed", () => Response.json({ data: [{ id: "z-ai/glm-5.3" }, { name: "no id" }] })],
])("publishes rows as authored when the inventory is %s", async (_scenario, respond) => {
  const bundle = await assembleFixtureBundle(inventoryManifests());
  const before = JSON.stringify(bundle);
  const warnings = captureWarnings();

  const result = await retireUnservedModels({ bundle, fetchImpl: async () => respond() });

  expect(result).toEqual({});
  expect(JSON.stringify(bundle)).toBe(before);
  expect(warnings()).toContain("publishing nvidia without inventory retirement");
  expect(warnings()).toContain("publishing novita without inventory retirement");
});

const FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";
const GLOBAL_RECOMMENDED = [
  "kimi-k3",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.3-flash",
  "nemotron-3-ultra-550b-a55b",
];

async function featuredRecommendations(respond: () => Response) {
  const bundle = await assembleFixtureBundle(
    fixtureManifests({
      nvidia: {
        models: [
          ...[
            "nvidia/nemotron-3-ultra-550b-a55b",
            "nvidia/nemotron-3-super-120b-a12b",
            "z-ai/glm-5.3",
            "z-ai/glm-5.2",
            "z-ai/glm-5.3-flash",
            "deepseek-ai/deepseek-v4.1-flash",
          ].map((id) => ({ id })),
          { id: "deepseek-ai/deepseek-v4-flash", status: "deprecated", statusReason: "old" },
          { id: "moonshotai/kimi-k3" },
        ],
      },
    }),
  );
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    expect(requestUrl(input)).toBe(FEATURED_MODELS_URL);
    return respond();
  });
  const featured = await resolveProviderFeaturedModels({ bundle, fetchImpl });
  const bundleV2 = await assembleModelCatalogBundleV2(
    bundle,
    new WeakMap(),
    undefined,
    GLOBAL_RECOMMENDED,
    featured,
  );
  return { featured, recommended: bundleV2.providers.nvidia?.recommendedModels };
}

function featuredFeed(ids: string[]) {
  return Response.json({ "featured-models": ids.map((model) => ({ model, context: 1 })) });
}

it("leads a provider's recommendations with its featured models, then the global list", async () => {
  const { featured, recommended } = await featuredRecommendations(() =>
    featuredFeed([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nemotron-3-super-120b-a12b",
      "z-ai/glm-5-3",
      // An older family member is a provider pick, so the family rule keeps it.
      "z-ai/glm-5.2",
      "deepseek-ai/deepseek-v4.1-flash",
      "deepseek-ai/deepseek-v4-flash",
      "nvidia/unserved-model",
    ]),
  );

  const picks = [
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3-super-120b-a12b",
    "z-ai/glm-5.3",
    "z-ai/glm-5.2",
    "deepseek-ai/deepseek-v4.1-flash",
  ];
  expect(featured).toEqual({
    nvidia: {
      ids: picks,
      skipped: ["deepseek-ai/deepseek-v4-flash", "nvidia/unserved-model"],
    },
  });
  expect(recommended).toEqual([...picks, "moonshotai/kimi-k3", "z-ai/glm-5.3-flash"]);
});

it.each([
  ["unavailable", () => new Response("Gone.", { status: 404 }), true],
  ["malformed", () => Response.json({ "featured-models": [{ model: "z-ai/glm-5.2" }, {}] }), true],
  ["unmatched", () => featuredFeed(["nvidia/unserved-model"]), true],
  ["empty", () => featuredFeed([]), false],
])("falls back to the global list when the featured feed is %s", async (_s, respond, warns) => {
  const warnings = captureWarnings();

  const { recommended } = await featuredRecommendations(respond);

  expect(recommended).toEqual([
    "moonshotai/kimi-k3",
    "deepseek-ai/deepseek-v4.1-flash",
    "z-ai/glm-5.3",
    "z-ai/glm-5.3-flash",
    "nvidia/nemotron-3-ultra-550b-a55b",
  ]);
  expect(warnings()).toEqual(
    warns ? expect.stringContaining("publishing nvidia with global recommendations only") : "",
  );
});

it("does not fetch models.dev without a provider catalog", async () => {
  const modelsDev = { other: "upstream-other" };
  const manifests = fixtureManifests({}, { modelsDev });
  manifests[0]!.manifest.providers = ["anthropic", "openai", "other"];
  const { hydrate } = await catalogFixture(manifests);
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(hydrate(fetchImpl)).resolves.toEqual({});
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("parses supported CLI arguments and rejects missing output", () => {
  expect(parsePublishModelCatalogArgs(["--dry-run", "--out", "ignored.json"])).toEqual({
    dryRun: true,
    pricing: false,
    out: "ignored.json",
  });
  expect(parsePublishModelCatalogArgs(["--pricing", "--dry-run"])).toEqual({
    dryRun: true,
    pricing: true,
  });
  expect(() => parsePublishModelCatalogArgs([])).toThrow("provide --out");
});

it("enriches catalog models and emits unmatched hosted pricing keys", async () => {
  const anthropic = fixtureProvider("claude", 100);
  anthropic.models[0] = { id: "claude-3-5-sonnet" };
  const openai = fixtureProvider("gpt", 100);
  openai.models[0] = { id: "gpt-special" };
  openai.models[1] = { id: "zero-upstream", cost: { input: 5, output: 6 } };
  const manifests = [
    manifestEntry("anthropic", {
      providers: ["anthropic"],
      modelCatalog: { providers: { anthropic } },
      modelPricing: {
        providers: { anthropic: { openRouter: { modelIdTransforms: ["version-dots"] } } },
      },
    }),
    manifestEntry("openai", { modelCatalog: { providers: { openai } } }),
    manifestEntry("openrouter", {
      providers: ["openrouter"],
      modelPricing: {
        providers: {
          openrouter: {
            openRouter: { passthroughProviderModel: true },
            liteLLM: false,
          },
        },
      },
    }),
    manifestEntry("mapped", {
      providers: ["mapped"],
      modelPricing: {
        providers: {
          mapped: {
            openRouter: { provider: "approved-source" },
            liteLLM: false,
          },
        },
      },
    }),
  ];
  const { bundle, enrich } = await catalogFixture(manifests);
  const fetchImpl = async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url === OPENROUTER_MODELS_URL) {
      return Response.json({
        data: [
          routerModel("anthropic/claude-3.5-sonnet", "0.000001", "0.000002"),
          routerModel("openai/gpt-special", "0.000003", "0.000004", {
            input_cache_read: "0.0000005",
            input_cache_write: "0.0000025",
            overrides: [{ min_prompt_tokens: 1000, prompt: "0.000007" }],
          }),
          routerModel("openai/gpt-2", "-1", "0.000004"),
          routerModel("unknown/new-model", "1", "1"),
          routerModel("custom/secondary-wins", "0", "0"),
          routerModel("mapped/wrong-source", "0.000013", "0.000014"),
        ],
      });
    }
    if (url === MODELS_DEV_CATALOG_URL) {
      return Response.json({});
    }
    expect(url).toBe(LITELLM_PRICING_URL);
    return Response.json({
      "gpt-special": {
        ...liteLLMPrice("openai", 0.000003, 0.000004),
        tiered_pricing: [tier(0.000005, 0.000006, [1000])],
      },
      "gpt-2": liteLLMPrice("openai", -1, 0.000004),
      "unknown/new-model": { input_cost_per_token: 1, output_cost_per_token: 1 },
      "external-model": liteLLMPrice("custom", 0.000007, 0.000008),
      "forbidden-model": liteLLMPrice("openrouter", 0.000009, 0.00001),
      "secondary-wins": liteLLMPrice("custom", 0.000011, 0.000012),
      "zero-upstream": liteLLMPrice("openai", 0, 0),
    });
  };

  await expect(enrich(fetchImpl)).resolves.toEqual({
    modelsEnriched: 1,
    pricingEntries: 10,
  });
  // OpenRouter's feed is OpenRouter's billing: its `anthropic/…` row never prices Anthropic.
  expect(bundle.providers.anthropic?.models[0]?.cost).toBeUndefined();
  const tieredPricing = [
    { input: 3, output: 4, cacheRead: 0.5, cacheWrite: 2.5, range: [0, 1001] },
    { input: 7, output: 4, cacheRead: 0.5, cacheWrite: 2.5, range: [1001] },
  ];
  // OpenAI's own row takes OpenAI's listed rate from LiteLLM, not OpenRouter's schedule.
  expect(bundle.providers.openai?.models[0]?.cost).toEqual({
    input: 3,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    tieredPricing: [{ input: 5, output: 6, cacheRead: 0, cacheWrite: 0, range: [1000] }],
  });
  expect(bundle.providers.openai?.models[1]?.cost).toEqual({ input: 5, output: 6 });
  expect(bundle.providers.openai?.models[2]?.cost).toBeUndefined();
  expect(bundle.pricing).toEqual({
    "custom/external-model": { input: 7, output: 8 },
    "custom/secondary-wins": { input: 11, output: 12 },
    "external-model": { input: 7, output: 8 },
    "forbidden-model": { input: 9, output: 10 },
    "openrouter/anthropic/claude-3.5-sonnet": { input: 1, output: 2 },
    "openrouter/mapped/wrong-source": { input: 13, output: 14 },
    "openrouter/openai/gpt-special": {
      input: 3,
      output: 4,
      cacheRead: 0.5,
      cacheWrite: 2.5,
      tieredPricing,
    },
    "openrouter/unknown/new-model": { input: 1_000_000, output: 1_000_000 },
    "secondary-wins": { input: 11, output: 12 },
    "unknown/new-model": { input: 1_000_000, output: 1_000_000 },
  });
  expect(summarizeModelCatalogBundle(bundle)).toMatchObject({
    models: 200,
    costModels: 2,
    pricingEntries: 10,
  });
  expect(Object.hasOwn(bundle.providers, "unknown")).toBe(false);
});

it("replaces declared context pricing when LiteLLM supplies tiers", async () => {
  const manifests = fixtureManifests({}, {}, false);
  const { bundle, enrich } = await catalogFixture(manifests);
  const model = bundle.providers.openai!.models[0]!;
  const declared: NonNullable<typeof model.cost> = {
    input: 10,
    output: 50,
    tieredPricing: [
      { input: 10, output: 50, cacheRead: 0, cacheWrite: 0, range: [0, 272_001] },
      { input: 20, output: 75, cacheRead: 0, cacheWrite: 0, range: [272_001] },
    ],
  };
  model.cost = declared;
  await enrich(async (input) => {
    if (requestUrl(input) === OPENROUTER_MODELS_URL) {
      return Response.json({
        data: [routerModel("openai/gpt-0", "0.000002", "0.000003")],
      });
    }
    return Response.json({
      "gpt-0": {
        ...liteLLMPrice("openai", 0.000002, 0.000003),
        tiered_pricing: [
          tier(0.000002, 0.000003, [0, 272_001]),
          tier(0.000004, 0.000003, [272_001]),
        ],
      },
    });
  });
  const published = bundle.providers.openai!.models[0]!.cost;
  expect(published).toMatchObject({ input: 2, output: 3 });
  expect(published?.tieredPricing?.at(-1)).toMatchObject({
    input: 4,
    output: 3,
    range: [272_001],
  });
  expect(bundle.pricing).not.toHaveProperty("openai/gpt-0");
  expect(bundle.pricing).not.toHaveProperty("gpt-0");
});

it("keeps metadata but removes unavailable OpenCode prices", async () => {
  const manifests = nativeManifests("OpenCode");
  const { bundle, enrich } = await catalogFixture(manifests);
  const model = bundle.providers.opencode!.models[0]!;
  model.cost = { input: 0, output: 0 };
  model.name = "Existing explicit model";
  model.contextWindow = 123_456;
  model.status = "deprecated";
  const expected = { ...model };
  delete expected.cost;
  const warnings = captureWarnings();
  await enrich(async (input) => {
    const request = requestUrl(input);
    if (request === OPENCODE_PRICING_URL) {
      return Response.json(openCodePrices({ input: 2, output: 3 }, ["new-priced-fixture"]));
    }
    if (request === OPENROUTER_MODELS_URL) {
      return Response.json({
        data: [
          routerModel("opencode/priced-fixture", "1", "1"),
          routerModel("opencode/absent-unbundled", "1", "1"),
        ],
      });
    }
    return Response.json({
      "priced-fixture": liteLLMPrice("opencode", 1, 1),
    });
  });
  expect(bundle.providers.opencode?.models[0]).toEqual(expected);
  expect(bundle.pricing).not.toHaveProperty("opencode/priced-fixture");
  expect(bundle.pricing).not.toHaveProperty("opencode/absent-unbundled");
  expect(bundle.pricing).not.toHaveProperty("priced-fixture");
  expect(bundle.pricing?.["opencode/new-priced-fixture"]).toEqual({
    input: 2,
    output: 3,
  });
  expect(warnings()).toContain("OpenCode pricing unavailable for opencode/priced-fixture");
  expect(
    resolveModelCostConfig({
      ...(await publishedPricingParams(bundle, "opencode")),
      model: "priced-fixture",
    }),
  ).toBeUndefined();
});

it.each(["malformed body", "invalid zero seed"])(
  "rejects %s instead of publishing unverified prices",
  async (scenario) => {
    const manifests = nativeManifests("OpenCode");
    const { bundle, enrich } = await catalogFixture(manifests);
    if (scenario === "invalid zero seed") {
      bundle.providers.opencode!.models[0]!.cost = { input: 0, output: 0 };
    }
    const fetchImpl: typeof fetch = async (input) => {
      const request = requestUrl(input);
      if (request === OPENROUTER_MODELS_URL) {
        return Response.json({ data: [] });
      }
      if (request === LITELLM_PRICING_URL || request === MODELS_DEV_CATALOG_URL) {
        return Response.json({});
      }
      expect(request).toBe(OPENCODE_PRICING_URL);
      if (scenario === "malformed body") {
        return Response.json({});
      }
      return Response.json(openCodePrices({ input: -1, output: 2 }));
    };
    await expect(enrich(fetchImpl)).rejects.toThrow("OpenCode pricing");
  },
);

it("does not fetch Venice without an owning opt-in", async () => {
  const manifests = nativeManifests("Venice");
  manifests[0]!.manifest.providers = ["anthropic", "openai"];
  const { enrich } = await catalogFixture(manifests);
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
  await enrich(fetchImpl);
  const urls = fetchImpl.mock.calls.map(([input]) => requestUrl(input));
  expect(urls.filter((fetched) => fetched === VENICE_PRICING_URL)).toHaveLength(0);
  expect(urls.toSorted()).toEqual(
    [LITELLM_PRICING_URL, MODELS_DEV_CATALOG_URL, OPENROUTER_MODELS_URL].toSorted(),
  );
});

it("fails soft on unreachable or malformed generic pricing", async () => {
  const manifests = fixtureManifests({}, {}, false);
  const { bundle, enrich } = await catalogFixture(manifests);
  const warnings = captureWarnings();
  await expect(
    enrich(async (input) => {
      if (requestUrl(input) === OPENROUTER_MODELS_URL) {
        throw new Error("offline");
      }
      return new Response("not-json", { status: 200 });
    }),
  ).resolves.toEqual({ modelsEnriched: 0, pricingEntries: 0 });
  expect(warnings()).toContain("OpenRouter pricing unavailable");
  expect(warnings()).toContain("LiteLLM pricing unavailable");
  expect(summarizeModelCatalogBundle(bundle).costModels).toBe(0);
});

it("publishes only verified source data: Venice unreachable", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-publish-failure-")));
  tempDirs.push(root);
  const out = path.join(root, "catalog.json");
  const preload = path.join(root, "offline.mjs");
  fs.writeFileSync(out, "previous published catalog\n");
  fs.writeFileSync(
    preload,
    `const manifests = ${JSON.stringify(readModelCatalogManifests().map((entry) => entry.manifest))};
const openCode = {};
for (const manifest of manifests) {
  for (const [provider, id] of Object.entries(manifest.modelCatalog?.modelsDev ?? {})) {
    const models = manifest.modelCatalog?.providers?.[provider]?.models ?? [];
    openCode[id] = { id, models: Object.fromEntries(models.map((model) => [model.id, { id: model.id, tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 128000, output: 32000 }, cost: { input: 1, output: 2 } }])) };
  }
  for (const [provider, policy] of Object.entries(manifest.modelPricing?.providers ?? {})) {
    if (!policy.openCode) continue;
    const id = policy.openCode.provider ?? provider;
    const models = manifest.modelCatalog?.providers?.[provider]?.models ?? [];
    openCode[id] = { id, models: Object.fromEntries(models.map((model) => [model.id, { id: model.id, cost: { input: 1, output: 2 } }])) };
  }
}
Object.assign(openCode.anthropic.models, ${JSON.stringify({ "fixture-discovered-model": modelsDevModel("fixture-discovered-model") })});
globalThis.fetch = async (url) => {
  if (url === ${JSON.stringify(OPENCODE_PRICING_URL)}) return Response.json(openCode);
  if (url === "https://api.deepinfra.com/models/list") return Response.json([{ model_name: "fixture/chat", pricing: { type: "tokens", cents_per_input_token: 0.0002, cents_per_output_token: 0.001 } }]);
  if (url === "https://llm.chutes.ai/v1/models") return Response.json({ data: [{ id: "fixture/chat", pricing: { prompt: 2, completion: 10 } }] });
  if (url === "https://api.cerebras.ai/public/v1/models") return Response.json({ data: [{ id: "fixture/chat", pricing: { prompt: "0.000002", completion: "0.00001" } }] });
  if (url === ${JSON.stringify(VENICE_PRICING_URL)}) throw new Error("fixture outage");
  return Response.json({ data: [] });
};`,
  );
  const result = spawnSync(
    process.execPath,
    [
      ...(process.versions.bun ? [] : ["--import", "tsx"]),
      "--import",
      preload,
      "scripts/publish-model-catalog.mts",
      "--pricing",
      "--out",
      out,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("Venice pricing");
  expect(result.stderr.trim().split("\n").at(-1)).toBe("[publish-model-catalog] FAILED (exit 1)");
  expect(fs.readFileSync(out, "utf8")).toBe("previous published catalog\n");
});
