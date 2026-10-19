import fs from "node:fs/promises";
import path from "node:path";
import type {
  RemoteModelCatalogPricing,
  RemoteModelCatalogPricingV2,
} from "@openclaw/model-catalog-core";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MODELS_JSON_STATE } from "../agents/models-config-state.js";
import * as runtimeNormalization from "../agents/provider-model-normalization.runtime.js";
import { resolveResponseUsageLine } from "../auto-reply/reply/agent-runner-usage-line.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store-path.js";
import * as manifestNormalization from "../plugins/manifest-model-id-normalization.js";
import { normalizeManifestModelPricing } from "../plugins/manifest-model-provider-normalizers.js";
import type { PersistedInstalledPluginIndexCacheEntry } from "../plugins/plugin-cache-management.js";
import {
  createPluginCache,
  preparePluginCacheFact,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { buildStatusMessageParts, statusModelRefs } from "../status/status-message.test-support.js";
import {
  estimateAggregateUsageCost,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
import {
  prepareModelPricingContext,
  resolveModelPricing,
  resolveModelPricingContext,
} from "./pricing.js";
import {
  prepareRemoteModelCatalogStartupSnapshot,
  getRemoteModelCatalogProviderOverlay,
} from "./remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hostedUrl = "https://api.openai.com/v1";
const privateUrl = "http://127.0.0.1:8080/v1";
function tokenRates(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output, cacheRead, cacheWrite };
}
function storedCatalog(bundle: Record<string, unknown>) {
  return {
    id: 1,
    source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
    bundle_json: JSON.stringify({
      schemaVersion: 1,
      generatedAt: 200,
      sourceCommit: "pricing-test",
      providers: {},
      ...bundle,
    }),
    generated_at: 200,
    min_version: null,
    etag: null,
    last_modified: null,
    checked_at: 200,
  };
}
type CatalogSources = NonNullable<Parameters<typeof setRemoteModelCatalogOverlaySourcesForTest>[0]>;
function useCatalog(readStoredCatalog: CatalogSources["readStoredCatalog"]) {
  setRemoteModelCatalogOverlaySourcesForTest({ bundledGeneratedAt: () => 100, readStoredCatalog });
}
function resetPricing() {
  clearRuntimeConfigSnapshot();
  MODELS_JSON_STATE.costCache.clear();
  setRemoteModelCatalogOverlaySourcesForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}
const known = { status: "known", currency: "USD", unit: "million_tokens" } as const;
type PricingModel = Pick<ModelDefinitionConfig, "id" | "name"> &
  Omit<Partial<ModelDefinitionConfig>, "cost"> & { cost?: Partial<ModelDefinitionConfig["cost"]> };
function configFor(
  baseUrl = hostedUrl,
  models: PricingModel[] = [{ id: "gpt-external", name: "External GPT" }],
  provider = "openai",
): OpenClawConfig {
  return {
    models: { providers: { [provider]: { baseUrl, models } } },
  } as unknown as OpenClawConfig;
}
function costFor(config: OpenClawConfig, model: string, agentDir?: string, provider = "openai") {
  return resolveModelCostConfig({ config, model, agentDir, provider });
}
describe("hosted model pricing", () => {
  const readStoredCatalog = vi.fn();
  async function prepareCatalog(bundle: Record<string, unknown>) {
    readStoredCatalog.mockReturnValue(storedCatalog(bundle));
    useCatalog(readStoredCatalog);
    await prepareRemoteModelCatalogStartupSnapshot();
  }

  beforeEach(async () => {
    clearRuntimeConfigSnapshot();
    MODELS_JSON_STATE.costCache.clear();
    readStoredCatalog.mockReset();
    await prepareCatalog({
      minVersion: "2026.7.0",
      providers: {
        openai: {
          models: [
            { id: "gpt-catalog", cost: { input: 1, output: 2 } },
            {
              id: "gpt-authored",
              cost: {
                ...tokenRates(2, 8, 0.5, 1),
                tieredPricing: [
                  { ...tokenRates(2, 8, 0.5, 1), range: [0, 201] },
                  { ...tokenRates(4, 16, 1, 2), range: [201] },
                ],
              },
            },
          ],
        },
      },
      pricing: {
        "openai/gpt-external": { input: 2.5, output: 10, cacheRead: 1.25 },
        "openai/gpt-zero-hosted": {
          input: 0,
          output: 0,
          tieredPricing: [{ ...tokenRates(0, 0), range: [0] }],
        },
      },
    });
  });

  afterEach(resetPricing);

  it("keeps normalized indexes scoped to their policy and observes model-file prices", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-prepared-pricing-"));
    const model = {
      id: "alias",
      name: "Alias",
      reasoning: false,
      input: ["text" as const],
      cost: tokenRates(3, 0),
      maxTokens: 8192,
    };
    const providers = { fixture: { baseUrl: "https://fixture.invalid", models: [model] } };
    const firstConfig: OpenClawConfig = { models: { providers } };
    const secondConfig: OpenClawConfig = { models: { providers } };
    const enumeratePolicies = vi.fn(Reflect.ownKeys);
    const snapshotFor = (canonicalModel: string) =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            providers: ["fixture"],
            modelIdNormalization: {
              providers: new Proxy(
                { fixture: { aliases: { alias: canonicalModel } } },
                { ownKeys: (target) => enumeratePolicies(target) },
              ),
            },
          },
        ],
      });
    const metadataSpy = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync")
      .mockResolvedValueOnce(snapshotFor("first"))
      .mockResolvedValueOnce(snapshotFor("second"));
    await prepareModelPricingContext(firstConfig);
    await prepareModelPricingContext(secondConfig);
    enumeratePolicies.mockClear();
    const agentDir = tempDirs.make("openclaw-policy-pricing-");
    const lookup = () =>
      [firstConfig, secondConfig].flatMap((config) =>
        ["first", "second"].map(
          (modelId) =>
            resolveModelCostConfig({ config, agentDir, provider: "fixture", model: modelId })
              ?.input,
        ),
      );
    expect(lookup()).toEqual([3, undefined, undefined, 3]);
    expect(lookup()).toEqual([3, undefined, undefined, 3]);

    const fileModel = { ...model, id: "alias", cost: { ...model.cost, input: 17 } };
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { fixture: { ...providers.fixture, models: [fileModel] } } }),
    );
    expect(lookup()).toEqual([17, undefined, undefined, 17]);
    expect(metadataSpy).toHaveBeenCalledTimes(2);
    expect(enumeratePolicies).not.toHaveBeenCalled();
  });

  it("keeps optional metadata read failures nonfatal", async () => {
    readStoredCatalog.mockClear();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-prepared-pricing-"));
    const config = configFor(hostedUrl);
    const cache = createPluginCache();
    const reading = createDeferredCore();
    const key = resolveInstalledPluginIndexStorePath({ env: process.env });
    vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync")
      .mockImplementationOnce(async () => {
        await preparePluginCacheFact(cache, cache.persistedInstalledIndex, key, async () => {
          await reading.promise;
          return {
            state: { status: "missing" },
          } satisfies PersistedInstalledPluginIndexCacheEntry;
        });
        return createPluginMetadataSnapshotFixture();
      })
      .mockResolvedValue(createPluginMetadataSnapshotFixture());
    const preparing = withPluginCache(cache, () => prepareModelPricingContext(config));
    const settled = expect(preparing).resolves.toBeUndefined();
    reading.reject(new Error("optional metadata unavailable"));
    await settled;
    expect(readStoredCatalog).not.toHaveBeenCalled();
    expect(costFor(config, "gpt-external")).toBeUndefined();
  });

  it("accepts exact free pricing from an authoritative native source", async () => {
    const agentDir = tempDirs.make("openclaw-native-zero-policy-");
    vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
    const config: OpenClawConfig = {
      plugins: { allow: ["venice"], entries: { venice: { enabled: true } } },
    };
    const snapshot = pluginMetadata.resolvePluginMetadataSnapshot({ config, env: process.env });
    const plugins = [...snapshot.manifestRegistry.plugins];
    const ownerIndex = plugins.findIndex((plugin) => plugin.id === "venice");
    plugins[ownerIndex] = {
      ...expectDefined(plugins[ownerIndex], "Venice manifest owner"),
      modelPricing: normalizeManifestModelPricing(
        { providers: { venice: { openCode: { provider: "upstream" } } } },
        { ownedProviders: new Set(["venice"]) },
      ),
    };
    vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockReturnValue({
      ...snapshot,
      manifestRegistry: { ...snapshot.manifestRegistry, plugins },
    });
    await prepareCatalog({
      providers: { venice: { models: [{ id: "zero-fixture", cost: { input: 0, output: 0 } }] } },
      pricing: {
        "venice/zero-fixture": { input: 0, output: 0 },
      },
    });
    expect(costFor(config, "zero-fixture", agentDir, "venice")).toEqual(tokenRates(0, 0));
  });

  // The bundled Anthropic manifest prices its claude-cli backend as anthropic.
  async function resolveClaudeCliCost(pricing: Record<string, unknown>) {
    const agentDir = tempDirs.make("openclaw-price-as-");
    vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
    const config: OpenClawConfig = {};
    await prepareCatalog({ pricing });
    await prepareModelPricingContext(config);
    const resolve = (provider: string) => costFor(config, "claude-opus-5-5", agentDir, provider);
    return { cli: resolve("claude-cli"), anthropic: resolve("anthropic") };
  }

  it("prices a priceAs provider with its target's catalog row", async () => {
    const { cli, anthropic } = await resolveClaudeCliCost({});
    expect(cli).toMatchObject({ input: 4, output: 20 });
    expect(cli).toEqual(anthropic);
  });

  it("never follows priceAs past the source provider's pricing exclusions", () => {
    const rates = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
    const contextFor = (
      config: OpenClawConfig,
      external: boolean,
    ): Parameters<typeof resolveModelPricing>[0] => ({
      config,
      normalizeKey: (provider, model) => `${provider}/${model}`,
      catalog: new Map([["anthropic/claude-opus-5-5", rates]]),
      hosted: {},
      upstream: {},
      normalizedHosted: new Map(),
      policies: new Map([
        [
          "claude-cli",
          { external, authoritative: false, passthroughSources: [], priceAs: "anthropic" },
        ],
      ]),
      fingerprint: "price-as-exclusions",
    });
    const key = "claude-cli/claude-opus-5-5";
    const privateEndpoint = configFor(privateUrl, [], "claude-cli");

    expect(resolveModelPricing(contextFor({}, true), key)).toEqual(rates);
    expect(resolveModelPricing(contextFor({}, false), key)).toBeUndefined();
    expect(resolveModelPricing(contextFor(privateEndpoint, true), key)).toBeUndefined();
  });

  it("keeps a priceAs provider's own price ahead of its target's", async () => {
    const { cli } = await resolveClaudeCliCost({
      "claude-cli/claude-opus-5-5": { input: 1, output: 2 },
    });
    expect(cli).toMatchObject({ input: 1, output: 2 });
  });

  const catalogRates = tokenRates(2, 8, 0.5, 1);
  const catalogTiers: ModelDefinitionConfig["cost"]["tieredPricing"] = [
    { ...catalogRates, range: [0, 201] },
    { ...tokenRates(4, 16, 1, 2), range: [201, Infinity] },
  ];
  const preparedRates = tokenRates(11, 13, 17, 19);
  function pricingCase(
    name: string,
    cost: PricingModel["cost"],
    expected: ModelDefinitionConfig["cost"],
    display?: [total: number, price: string],
  ) {
    return { name, cost, expected, display };
  }

  it.each([
    pricingCase("sizing-only", undefined, { ...catalogRates, tieredPricing: catalogTiers }),
    pricingCase("partial cost", { output: 3 }, { ...catalogRates, output: 3 }),
    pricingCase("partial cost", { output: 3 }, { ...preparedRates, output: 3 }, [0.05, "$0.05"]),
    pricingCase("zero cost", tokenRates(0, 0), tokenRates(0, 0), [0, "$0.0000"]),
    pricingCase(
      "authored tiers",
      { tieredPricing: [{ ...tokenRates(7, 9, 1, 2), range: [0] }] },
      {
        ...catalogRates,
        tieredPricing: [{ ...tokenRates(7, 9, 1, 2), range: [0, Infinity] }],
      },
    ),
  ])("resolves $name from authored pricing (display=$display)", ({ cost, expected, display }) => {
    const allowPluginNormalization = !display;
    const [total, price] = display ?? [];
    const source: OpenClawConfig = {
      ...configFor(hostedUrl, [
        {
          id: "gpt-authored",
          name: "Authored GPT",
          contextWindow: 64_000,
          ...(cost ? { cost } : {}),
        },
      ]),
      messages: { responseUsage: "full" },
    };
    const runtime = structuredClone(source);
    const model = expectDefined(runtime.models?.providers?.openai?.models[0], "materialized model");
    model.cost = {
      ...preparedRates,
      tieredPricing: [{ ...preparedRates, range: [0] }],
    };
    setRuntimeConfigSnapshot(runtime, source);
    const agentDir = tempDirs.make("openclaw-authored-pricing-");
    vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
    const fetch = vi.fn(() => {
      throw new Error("pricing display must not use the network");
    });
    vi.stubGlobal("fetch", fetch);
    for (const config of [runtime, structuredClone(runtime)]) {
      MODELS_JSON_STATE.costCache.clear();
      const discoverySpies = allowPluginNormalization
        ? []
        : [
            vi.spyOn(manifestNormalization, "resolveManifestModelIdNormalizationPolicies"),
            vi.spyOn(runtimeNormalization, "normalizeProviderModelIdWithRuntime"),
            vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot"),
          ];
      const params = { config, agentDir, provider: "openai", model: "gpt-authored" };
      const resolvedCost = resolveModelCostConfig({ ...params, allowPluginNormalization });
      expect.soft(resolvedCost).toEqual(expected);
      if (allowPluginNormalization) {
        expect(resolveModelCostConfigFingerprint(config, agentDir)).toBe(
          resolveModelCostConfigFingerprint(source, agentDir),
        );
        continue;
      }
      const usage = { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 };
      const estimate = estimateAggregateUsageCost({ usage, cost: resolvedCost });
      if (total === undefined) {
        expect.soft(estimate).toBeUndefined();
      } else {
        expect.soft(estimate).toBeCloseTo(total);
      }
      expect
        .soft(resolveResponseUsageLine({ ...params, usage }))
        .toBe(
          `Usage: 1.0k in / 1.0k out · cache 1.0k cached / 1.0k new${price ? ` · est ${price}` : ""}`,
        );
      for (const spy of discoverySpies) {
        expect.soft(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
      const status = buildStatusMessageParts({
        modelRefs: statusModelRefs({ provider: "openai", model: "gpt-authored" }),
        config,
        agent: { model: "openai/gpt-authored" },
        modelAuth: "api-key",
        activeModelAuth: "api-key",
        sessionEntry: {
          sessionId: "prepared-pricing",
          updatedAt: 0,
          modelProvider: "openai",
          model: "gpt-authored",
          inputTokens: 1000,
          outputTokens: 1000,
          cacheRead: 1000,
          cacheWrite: 1000,
        },
      });
      if (price) {
        expect.soft(status.text).toContain(`Cost: ${price}`);
      } else {
        expect.soft(status.text).not.toContain("Cost:");
      }
      const rows = status.presentation.blocks.flatMap((block) =>
        block.type === "table" ? block.rows : [],
      );
      expect.soft(rows.find((row) => row[0] === "💵 Cost")?.[1]).toBe(price);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(model.contextWindow).toBe(64_000);
  });

  it("preserves independent configured pricing with an incompatible runtime snapshot", () => {
    const runtime = { agents: { defaults: {} } } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(runtime, {});
    const config = configFor(hostedUrl, [
      { id: "gpt-authored", name: "Authored GPT", cost: { output: 3 } },
    ]);
    const agentDir = tempDirs.make("openclaw-independent-pricing-");
    expect(costFor(config, "gpt-authored", agentDir)).toEqual({ ...catalogRates, output: 3 });
    const preparedCost = (model: string) =>
      resolveModelCostConfig({
        config,
        agentDir,
        provider: "openai",
        model,
        allowPluginNormalization: false,
      });
    expect(preparedCost("gpt-authored")).toEqual(tokenRates(0, 3));
    expect(preparedCost("missing")).toBeUndefined();
  });

  it("invalidates pricing fingerprints when authored empty tiers replace inherited tiers", () => {
    const cost = {} as ModelDefinitionConfig["cost"];
    const config = configFor(hostedUrl, [{ id: "gpt-authored", name: "Authored GPT", cost }]);
    const agentDir = tempDirs.make("openclaw-empty-tier-pricing-");
    expect(costFor(config, "gpt-authored", agentDir)).toEqual({
      ...catalogRates,
      tieredPricing: catalogTiers,
    });
    const before = resolveModelCostConfigFingerprint(config, agentDir);
    cost.tieredPricing = [];
    expect(resolveModelCostConfigFingerprint(config, agentDir)).not.toBe(before);
    expect(costFor(config, "gpt-authored", agentDir)).toEqual(catalogRates);
  });

  it("does not apply hosted pricing to private endpoints or unknown models", () => {
    const agentDir = tempDirs.make("openclaw-private-pricing-");
    expect(costFor(configFor(privateUrl), "gpt-external", agentDir)).toBeUndefined();
    expect(resolveModelCostConfigFingerprint(configFor(hostedUrl))).not.toBe(
      resolveModelCostConfigFingerprint(configFor(privateUrl)),
    );
    expect(costFor(configFor("https://fc-proxy.example.com/v1"), "gpt-external", agentDir)).toEqual(
      tokenRates(2.5, 10, 1.25),
    );
    expect(costFor(configFor(privateUrl), "gpt-catalog", agentDir)).toBeUndefined();
    expect(costFor(configFor(hostedUrl), "unknown-model", agentDir)).toBeUndefined();
    expect(costFor(configFor(hostedUrl), "gpt-zero-hosted", agentDir)).toBeUndefined();
    const disabled = configFor(hostedUrl);
    disabled.models = {
      ...disabled.models,
      catalogRefresh: { enabled: false },
    };
    expect(costFor(disabled, "gpt-external", agentDir)).toBeUndefined();
  });

  it("fingerprints provider overlays without explicit model rows", () => {
    const config = {
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } },
    } as unknown as OpenClawConfig;
    expect(() => resolveModelCostConfigFingerprint(config)).not.toThrow();
  });

  it("keeps optional pricing non-throwing without an ambient agent owner", () => {
    const config: OpenClawConfig = {
      ...configFor(
        "https://fixture.invalid",
        [{ id: "priced", name: "Priced", cost: tokenRates(1, 2) }],
        "fixture",
      ),
      agents: { ownership: "explicit", entries: { main: {}, other: {} } },
    };

    expect(costFor(config, "priced", undefined, "fixture")).toEqual(tokenRates(1, 2));
    expect(costFor(config, "missing", undefined, "fixture")).toBeUndefined();
    expect(() => resolveModelCostConfigFingerprint(config)).not.toThrow();
  });

  it("bounds fingerprints for multi-megabyte hosted pricing catalogs", async () => {
    const pricing = Object.fromEntries(
      Array.from({ length: 40_000 }, (_, index) => [
        `openai/catalog-model-${index}`,
        { input: index + 1, output: index + 2, cacheRead: index + 3 },
      ]),
    );
    const record = storedCatalog({
      minVersion: "2026.7.0",
      providers: {
        openai: { models: [{ id: "catalog-model-0", cost: { input: 1, output: 2 } }] },
      },
      pricing,
    });
    expect(Buffer.byteLength(record.bundle_json)).toBeGreaterThan(2 * 1024 * 1024);
    readStoredCatalog.mockReturnValue(record);
    useCatalog(readStoredCatalog);
    await prepareRemoteModelCatalogStartupSnapshot();
    const config = configFor(hostedUrl);
    const fingerprint = resolveModelCostConfigFingerprint(config);
    const contextFingerprint = resolveModelPricingContext(config).fingerprint;
    const withoutHostedPricing = configFor(hostedUrl);
    withoutHostedPricing.models = {
      ...withoutHostedPricing.models,
      catalogRefresh: { enabled: false },
    };

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(contextFingerprint.length).toBe(64);
    expect(contextFingerprint).not.toBe(
      resolveModelPricingContext(withoutHostedPricing).fingerprint,
    );
    expect(fingerprint).not.toBe(resolveModelCostConfigFingerprint(withoutHostedPricing));
  });
});

describe("OpenRouter routing shortcut estimates", () => {
  const routerUrl = "https://openrouter.ai/api/v1";
  let hostedPricing: Record<string, RemoteModelCatalogPricing>;

  beforeEach(() => {
    MODELS_JSON_STATE.costCache.clear();
    hostedPricing = {
      "openrouter/openai/gpt-catalog": { input: 1, output: 2 },
      "openai/gpt-catalog": { input: 4, output: 5 },
    };
    useCatalog(() =>
      storedCatalog({
        providers: {},
        pricing: hostedPricing,
      }),
    );
  });

  afterEach(resetPricing);

  it("prices the OpenRouter :nitro shortcut after endpoint checks", async () => {
    await prepareRemoteModelCatalogStartupSnapshot();
    const agentDir = tempDirs.make("openclaw-routing-pricing-");
    const model = "openai/gpt-catalog:nitro";
    const rates = { input: 1, output: 2 };
    const entry: ModelDefinitionConfig = {
      id: model,
      name: "Routing shortcut",
      reasoning: false,
      input: ["text"],
      cost: tokenRates(0, 0),
      maxTokens: 8192,
    };
    const configWith = (baseUrl: string, modelEntry = entry) =>
      configFor(baseUrl, [modelEntry], "openrouter");
    const resolve = (config: OpenClawConfig) => {
      const context = resolveModelPricingContext(config);
      return resolveModelPricing(context, context.normalizeKey("openrouter", model));
    };
    expect(resolve(configWith(routerUrl))).toEqual(rates);
    expect(
      resolve(
        configFor(
          routerUrl,
          [entry, { ...entry, id: "openai/gpt-catalog", baseUrl: privateUrl }],
          "openrouter",
        ),
      ),
    ).toEqual(rates);
    expect(resolve(configWith(privateUrl))).toBeUndefined();
    expect(
      resolve(
        configWith(routerUrl, {
          ...entry,
          baseUrl: privateUrl,
        }),
      ),
    ).toBeUndefined();
    for (const input of [0, 9]) {
      const cost = tokenRates(input, input);
      expect(
        resolveModelCostConfig({
          config: configWith(routerUrl, { ...entry, cost }),
          agentDir,
          provider: "openrouter",
          model,
        }),
      ).toEqual(cost);
    }
  });

  it("retains exact shortcut prices and does not strip distinct or nested variants", async () => {
    const agentDir = tempDirs.make("openclaw-routing-variants-");
    hostedPricing["openrouter/openai/gpt-catalog:nitro"] = { input: 7, output: 8 };
    hostedPricing["openrouter/openai/gpt-catalog:free"] = { input: 3, output: 4 };
    await prepareRemoteModelCatalogStartupSnapshot();
    const config = configFor(routerUrl, [], "openrouter");
    const resolve = (model: string, provider = "openrouter") =>
      resolveModelCostConfig({ config, agentDir, provider, model });
    expect(resolve("openai/gpt-catalog:nitro")).toEqual(tokenRates(7, 8));
    expect(resolve("openai/gpt-catalog:free")).toEqual(tokenRates(3, 4));
    for (const suffix of [
      "batch",
      "extended",
      "thinking",
      "online",
      "unknown",
      "free:nitro",
      "nitro:floor",
    ]) {
      expect(resolve(`openai/gpt-catalog:${suffix}`), suffix).toBeUndefined();
    }
    expect(resolve("openai/unknown:floor")).toBeUndefined();
    expect(resolve("gpt-catalog:floor", "openai")).toBeUndefined();
  });
});

describe("standalone v2 pricing", () => {
  const passthrough = { passthroughProviderModel: true } as const;

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-v2-standalone-"));
    MODELS_JSON_STATE.costCache.clear();
    vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "gateway",
            providers: ["gateway"],
            modelPricing: {
              providers: { gateway: { openRouter: passthrough, liteLLM: passthrough } },
            },
          },
          {
            id: "litegate",
            providers: ["litegate"],
            modelPricing: { providers: { litegate: { openRouter: false, liteLLM: passthrough } } },
          },
          {
            id: "vendor",
            providers: ["vendor"],
            modelCatalog: {
              providers: { vendor: { models: [{ id: "catalogued" }, { id: "rowpriced" }] } },
            },
            modelIdNormalization: {
              providers: { vendor: { aliases: { "catalogued-latest": "catalogued" } } },
            },
          },
        ],
      }),
    );
    useCatalog(() =>
      storedCatalog({
        schemaVersion: 2,
        providers: { vendor: {} },
        models: [
          { id: "catalogued", provider: "vendor", pricing: { status: "unknown" } },
          {
            id: "rowpriced",
            provider: "vendor",
            pricing: { ...known, input: 4, output: 20 },
          },
        ],
        upstreamPricing: {
          "vendor/listed": {
            input: 2,
            output: 4,
            source: "openRouter",
            alternatives: [{ input: 2.5, output: 5, source: "liteLLM" }],
          },
          // A mirror's unflagged upstream rate for a vendor model with an unknown row.
          "vendor/catalogued": { input: 5, output: 10, source: "openRouter" },
          // An unflagged rate under an alias of that unknown row.
          "vendor/catalogued-latest": { input: 6, output: 11, source: "openRouter" },
          // A reseller's promotional rate for a vendor model that has its own catalog row.
          "vendor/rowpriced": {
            input: 2,
            output: 10,
            source: "openRouter",
            passthroughOnly: true,
          },
        },
        providerPricing: {
          // A mirror's standalone rate colliding with an unknown catalog row.
          "vendor/catalogued": { input: 7, output: 7, source: "modelsDev" },
        },
      }),
    );
    await prepareRemoteModelCatalogStartupSnapshot();
  });

  afterEach(resetPricing);

  it.each([
    ["vendor/catalogued", undefined],
    ["gateway/vendor/rowpriced", tokenRates(4, 20)],
    ["litegate/vendor/listed", tokenRates(2.5, 5)],
  ] as const)("resolves standalone pricing for %s", (ref, cost) => {
    const slash = ref.indexOf("/");
    expect(costFor({}, ref.slice(slash + 1), undefined, ref.slice(0, slash))).toEqual(cost);
  });
});

describe("inline v2 pricing", () => {
  let pricing: RemoteModelCatalogPricingV2;

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-v2-pricing-"));
    MODELS_JSON_STATE.costCache.clear();
    pricing = { ...known, input: 0, output: 0, source: "models.dev" };
    vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: ["fixture", "other"].map((provider) => ({
          id: provider,
          providers: [provider],
          modelCatalog: {
            providers: {
              [provider]: { models: [{ id: "native/model", cost: { input: 9, output: 18 } }] },
            },
          },
          modelPricing: { providers: { [provider]: { external: true } } },
        })),
      }),
    );
    useCatalog(() =>
      storedCatalog({
        schemaVersion: 2,
        providers: { fixture: { defaultModel: "native/model" }, other: {} },
        models: [
          { id: "native/model", provider: "fixture", pricing },
          { id: "native/model", provider: "other", pricing: { ...known, input: 7, output: 14 } },
        ],
      }),
    );
  });

  afterEach(resetPricing);

  it.each([
    {
      name: "known free without a native source label",
      price: { ...known, input: 0, output: 0, source: "models.dev" },
      expected: { input: 0, output: 0 },
    },
    { name: "partial", price: { ...known, input: 3 }, expected: { input: 3 } },
    { name: "unknown", price: { status: "unknown" }, expected: undefined },
    { name: "withdrawn", price: { status: "unavailable", source: "native" }, expected: undefined },
  ] satisfies Array<{
    name: string;
    price: RemoteModelCatalogPricingV2;
    expected: { input: number; output?: number } | undefined;
  }>)("uses $name pricing without reviving the bundled price", async ({ price, expected }) => {
    pricing = price;
    await prepareRemoteModelCatalogStartupSnapshot();
    const config = {};
    const context = resolveModelPricingContext(config);
    expect(resolveModelPricing(context, "fixture/native/model")).toEqual(expected);
    expect(resolveModelPricing(context, "other/native/model")).toEqual({ input: 7, output: 14 });
    expect(getRemoteModelCatalogProviderOverlay(config, "fixture")).toMatchObject({
      defaultModel: "native/model",
      models: [{ id: "native/model" }],
    });
    expect(resolveModelCostConfig({ config, provider: "fixture", model: "native/model" })).toEqual(
      expected
        ? { input: expected.input, output: expected.output ?? 0, cacheRead: 0, cacheWrite: 0 }
        : undefined,
    );
  });

  it("does not let known zero bypass disabled external pricing", async () => {
    await prepareRemoteModelCatalogStartupSnapshot();
    const config: OpenClawConfig = {};
    const snapshot = pluginMetadata.resolvePluginMetadataSnapshot({ config, env: process.env });
    for (const plugin of snapshot.manifestRegistry.plugins) {
      if (plugin.id === "fixture") {
        plugin.modelPricing = { providers: { fixture: { external: false } } };
      }
    }
    expect(costFor(config, "native/model", undefined, "fixture")).toBeUndefined();
  });
});
