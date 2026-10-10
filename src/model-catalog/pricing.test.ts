import fs from "node:fs/promises";
import path from "node:path";
import type {
  RemoteModelCatalogPricing,
  RemoteModelCatalogPricingV2,
} from "@openclaw/model-catalog-core";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as runtimeNormalization from "../agents/provider-model-normalization.runtime.js";
import { resolveResponseUsageLine } from "../auto-reply/reply/agent-runner-usage-line.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-record-cache.js";
import { resolveInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store-path.js";
import * as manifestNormalization from "../plugins/manifest-model-id-normalization.js";
import { normalizeManifestModelPricing } from "../plugins/manifest-model-provider-normalizers.js";
import type { PersistedInstalledPluginIndexCacheEntry } from "../plugins/plugin-cache-management.js";
import {
  createPluginCache,
  preparePluginCacheFact,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { buildStatusMessageParts, statusModelRefs } from "../status/status-message.test-support.js";
import {
  estimateAggregateUsageCost,
  resetUsageFormatCachesForTest,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
import {
  prepareModelPricingContext,
  resolveModelPricing,
  resolveModelPricingContext,
} from "./pricing.js";
import { getRemoteModelCatalogProviderOverlay } from "./remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
describe("hosted model pricing", () => {
  const readStoredCatalog = vi.fn();

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    resetUsageFormatCachesForTest();
    readStoredCatalog.mockReset().mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: JSON.stringify({
        schemaVersion: 1,
        generatedAt: 200,
        minVersion: "2026.7.0",
        sourceCommit: "pricing-test",
        providers: {
          openai: {
            models: [
              { id: "gpt-catalog", cost: { input: 1, output: 2 } },
              { id: "pricing-model", cost: { input: 1, output: 2 } },
              { id: "openai/pricing-model", cost: { input: 3, output: 6 } },
              {
                id: "gpt-authored",
                cost: {
                  input: 2,
                  output: 8,
                  cacheRead: 0.5,
                  cacheWrite: 1,
                  tieredPricing: [
                    { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1, range: [0, 201] },
                    { input: 4, output: 16, cacheRead: 1, cacheWrite: 2, range: [201] },
                  ],
                },
              },
              {
                id: "gpt-zero-tier",
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  tieredPricing: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, range: [0] }],
                },
              },
            ],
          },
        },
        pricing: {
          "openai/pricing-model": { input: 91, output: 92 },
          "openai/openai/pricing-model": { input: 93, output: 94 },
          "openai/pricing-hosted": { input: 4, output: 8 },
          "openai/openai/pricing-hosted": { input: 5, output: 10 },
          "openai/gpt-external": { input: 2.5, output: 10, cacheRead: 1.25 },
          "openai/gpt-zero-hosted": {
            input: 0,
            output: 0,
            tieredPricing: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, range: [0] }],
          },
          "openai/gpt-zero-tier": { input: 4, output: 8 },
          "z-ai/forbidden": { input: 9, output: 18 },
        },
      }),
    });
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 100,
      readStoredCatalog,
    });
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetUsageFormatCachesForTest();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setRemoteModelCatalogOverlaySourcesForTest();
  });

  function configFor(baseUrl: string): OpenClawConfig {
    return {
      models: {
        providers: {
          openai: {
            baseUrl,
            models: [{ id: "gpt-external", name: "External GPT" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
  }

  it("keeps normalized indexes scoped to their policy while observing configured price changes", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-prepared-pricing-"));
    const model = {
      id: "alias",
      name: "Alias",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
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

    model.cost.input = 9;
    expect(lookup()).toEqual([9, undefined, undefined, 9]);
    model.cost = { input: 11, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(lookup()).toEqual([11, undefined, undefined, 11]);
    model.id = "unaliased";
    expect(lookup()).toEqual([undefined, undefined, undefined, undefined]);
    providers.fixture.models.push({ ...model, id: "alias" });
    expect(lookup()).toEqual([11, undefined, undefined, 11]);

    const fileModel = { ...model, id: "alias", cost: { ...model.cost, input: 17 } };
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { fixture: { ...providers.fixture, models: [fileModel] } } }),
    );
    expect(lookup()).toEqual([17, undefined, undefined, 17]);
    expect(metadataSpy).toHaveBeenCalledTimes(2);
    expect(enumeratePolicies).not.toHaveBeenCalled();
  });

  it.each([
    "retirement",
    "fact invalidation",
    "fact invalidation with read failure",
    "current read failure",
  ])("preserves pricing publication semantics after %s", async (change) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-prepared-pricing-"));
    const config = configFor("https://api.openai.com/v1");
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
    const settled =
      change === "current read failure"
        ? expect(preparing).resolves.toBeUndefined()
        : expect(preparing).rejects.toThrow();
    const retirement = change === "retirement" ? retirePluginCache(cache) : undefined;
    if (change.startsWith("fact invalidation")) {
      withPluginCache(cache, clearLoadInstalledPluginIndexInstallRecordsCache);
    }
    if (change === "fact invalidation") {
      reading.resolve();
    } else {
      reading.reject(new Error("optional metadata unavailable"));
    }
    await settled;
    await retirement;
    if (change === "current read failure") {
      expect(readStoredCatalog).not.toHaveBeenCalled();
      expect(
        resolveModelCostConfig({ config, provider: "openai", model: "gpt-external" }),
      ).toBeUndefined();
      return;
    }
    await withPluginCache(createPluginCache(), () => prepareModelPricingContext(config));
    expect(
      resolveModelCostConfig({ config, provider: "openai", model: "gpt-external" })?.input,
    ).toBe(2.5);
  });

  it("accepts exact free pricing from an authoritative native source", () => {
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
    readStoredCatalog.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: JSON.stringify({
        schemaVersion: 1,
        generatedAt: 200,
        sourceCommit: "native-zero-policy",
        providers: { venice: { models: [{ id: "zero-fixture", cost: { input: 0, output: 0 } }] } },
        pricing: {
          "venice/zero-fixture": { input: 0, output: 0 },
        },
      }),
    });
    const cost = resolveModelCostConfig({
      config,
      agentDir,
      provider: "venice",
      model: "zero-fixture",
    });
    expect(cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  const catalogRates = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1 };
  const catalogTiers = [
    { ...catalogRates, range: [0, 201] },
    { input: 4, output: 16, cacheRead: 1, cacheWrite: 2, range: [201, Infinity] },
  ];
  const preparedRates = { input: 11, output: 13, cacheRead: 17, cacheWrite: 19 };

  it.each([
    {
      name: "sizing-only",
      mode: "catalog",
      allowPluginNormalization: true,
      cost: undefined,
      expected: { ...catalogRates, tieredPricing: catalogTiers },
      total: undefined,
      price: undefined,
    },
    {
      name: "partial cost",
      mode: "catalog",
      allowPluginNormalization: true,
      cost: { output: 3 },
      expected: { ...catalogRates, output: 3 },
      total: undefined,
      price: undefined,
    },
    {
      name: "partial cost",
      mode: "prepared",
      allowPluginNormalization: false,
      cost: { output: 3 },
      expected: { ...preparedRates, output: 3 },
      total: 0.05,
      price: "$0.05",
    },
    {
      name: "zero cost",
      mode: "prepared",
      allowPluginNormalization: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      total: 0,
      price: "$0.0000",
    },
    {
      name: "authored tiers",
      mode: "catalog",
      allowPluginNormalization: true,
      cost: { tieredPricing: [{ input: 7, output: 9, cacheRead: 1, cacheWrite: 2, range: [0] }] },
      expected: {
        ...catalogRates,
        tieredPricing: [{ input: 7, output: 9, cacheRead: 1, cacheWrite: 2, range: [0, Infinity] }],
      },
      total: undefined,
      price: undefined,
    },
  ])(
    "resolves $name from authored source over $mode pricing",
    ({ cost, expected, allowPluginNormalization, total, price }) => {
      const source = {
        messages: { responseUsage: "full" },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-authored",
                  name: "Authored GPT",
                  contextWindow: 64_000,
                  ...(cost ? { cost } : {}),
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const runtime = structuredClone(source);
      const model = expectDefined(
        runtime.models?.providers?.openai?.models[0],
        "materialized model",
      );
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
        resetUsageFormatCachesForTest();
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
    },
  );

  it("preserves independent configured pricing with an incompatible runtime snapshot", () => {
    const runtime = { agents: { defaults: {} } } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(runtime, {});
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-authored", name: "Authored GPT", cost: { output: 3 } }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const agentDir = tempDirs.make("openclaw-independent-pricing-");
    expect(
      resolveModelCostConfig({ config, agentDir, provider: "openai", model: "gpt-authored" }),
    ).toEqual({ ...catalogRates, output: 3 });
    expect(
      resolveModelCostConfig({
        config,
        agentDir,
        provider: "openai",
        model: "gpt-authored",
        allowPluginNormalization: false,
      }),
    ).toEqual({ input: 0, output: 3, cacheRead: 0, cacheWrite: 0 });
    expect(
      resolveModelCostConfig({
        config,
        agentDir,
        provider: "openai",
        model: "missing",
        allowPluginNormalization: false,
      }),
    ).toBeUndefined();
  });

  it("invalidates pricing fingerprints when authored empty tiers replace inherited tiers", () => {
    const cost = {} as ModelDefinitionConfig["cost"];
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-authored", name: "Authored GPT", cost }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const agentDir = tempDirs.make("openclaw-empty-tier-pricing-");
    expect(
      resolveModelCostConfig({ config, agentDir, provider: "openai", model: "gpt-authored" }),
    ).toEqual({ ...catalogRates, tieredPricing: catalogTiers });
    const before = resolveModelCostConfigFingerprint(config, agentDir);
    cost.tieredPricing = [];
    expect(resolveModelCostConfigFingerprint(config, agentDir)).not.toBe(before);
    expect(
      resolveModelCostConfig({ config, agentDir, provider: "openai", model: "gpt-authored" }),
    ).toEqual(catalogRates);
  });

  it("does not apply hosted pricing to private endpoints or unknown models", () => {
    const agentDir = tempDirs.make("openclaw-private-pricing-");
    expect(
      resolveModelCostConfig({
        config: configFor("http://127.0.0.1:8080/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toBeUndefined();
    expect(resolveModelCostConfigFingerprint(configFor("https://api.openai.com/v1"))).not.toBe(
      resolveModelCostConfigFingerprint(configFor("http://127.0.0.1:8080/v1")),
    );
    expect(
      resolveModelCostConfig({
        config: configFor("https://fc-proxy.example.com/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toEqual({ input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 });
    expect(
      resolveModelCostConfig({
        config: configFor("http://127.0.0.1:8080/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-catalog",
      }),
    ).toBeUndefined();
    expect(
      resolveModelCostConfig({
        config: configFor("https://api.openai.com/v1"),
        agentDir,
        provider: "openai",
        model: "unknown-model",
      }),
    ).toBeUndefined();
    expect(
      resolveModelCostConfig({
        config: configFor("https://api.openai.com/v1"),
        agentDir,
        provider: "openai",
        model: "gpt-zero-hosted",
      }),
    ).toBeUndefined();
    const disabled = configFor("https://api.openai.com/v1");
    disabled.models = {
      ...disabled.models,
      catalogRefresh: { enabled: false },
    };
    expect(
      resolveModelCostConfig({
        config: disabled,
        agentDir,
        provider: "openai",
        model: "gpt-external",
      }),
    ).toBeUndefined();
  });

  it("fingerprints provider overlays without explicit model rows", () => {
    const config = {
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } },
    } as unknown as OpenClawConfig;
    expect(() => resolveModelCostConfigFingerprint(config)).not.toThrow();
  });

  it("keeps optional pricing non-throwing without an ambient agent owner", () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, other: {} },
      },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid",
            models: [
              {
                id: "priced",
                name: "Priced",
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveModelCostConfig({ config, provider: "fixture", model: "priced" })).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(
      resolveModelCostConfig({ config, provider: "fixture", model: "missing" }),
    ).toBeUndefined();
    expect(() => resolveModelCostConfigFingerprint(config)).not.toThrow();
  });

  it("bounds fingerprints for multi-megabyte hosted pricing catalogs", () => {
    const pricing = Object.fromEntries(
      Array.from({ length: 40_000 }, (_, index) => [
        `openai/catalog-model-${index}`,
        { input: index + 1, output: index + 2, cacheRead: index + 3 },
      ]),
    );
    const bundle = {
      schemaVersion: 1,
      generatedAt: 200,
      minVersion: "2026.7.0",
      sourceCommit: "large-pricing-test",
      providers: {
        openai: { models: [{ id: "catalog-model-0", cost: { input: 1, output: 2 } }] },
      },
      pricing,
    };
    const bundleJson = JSON.stringify(bundle);
    expect(Buffer.byteLength(bundleJson)).toBeGreaterThan(2 * 1024 * 1024);
    readStoredCatalog.mockReturnValue({
      source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
      bundle_json: bundleJson,
    });

    const fingerprint = resolveModelCostConfigFingerprint(configFor("https://api.openai.com/v1"));
    const withoutHostedPricing = configFor("https://api.openai.com/v1");
    withoutHostedPricing.models = {
      ...withoutHostedPricing.models,
      catalogRefresh: { enabled: false },
    };

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(fingerprint).not.toBe(resolveModelCostConfigFingerprint(withoutHostedPricing));
  });
});

describe("OpenRouter routing shortcut estimates", () => {
  let hostedPricing: Record<string, RemoteModelCatalogPricing>;

  beforeEach(() => {
    resetUsageFormatCachesForTest();
    hostedPricing = {
      "openrouter/openai/gpt-catalog": { input: 1, output: 2 },
      "openai/gpt-catalog": { input: 4, output: 5 },
    };
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 100,
      readStoredCatalog: () => ({
        id: 1,
        source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
        bundle_json: JSON.stringify({
          schemaVersion: 1,
          generatedAt: 200,
          sourceCommit: "routing-pricing-test",
          providers: {},
          pricing: hostedPricing,
        }),
        generated_at: 200,
        min_version: null,
        etag: null,
        last_modified: null,
        checked_at: 200,
      }),
    });
  });

  afterEach(() => {
    resetUsageFormatCachesForTest();
    vi.restoreAllMocks();
    setRemoteModelCatalogOverlaySourcesForTest();
  });

  it("prices the OpenRouter :nitro shortcut after endpoint checks", () => {
    const agentDir = tempDirs.make("openclaw-routing-pricing-");
    const model = "openai/gpt-catalog:nitro";
    const rates = { input: 1, output: 2 };
    const entry: ModelDefinitionConfig = {
      id: model,
      name: "Routing shortcut",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8192,
    };
    const configWith = (baseUrl: string, modelEntry = entry): OpenClawConfig => ({
      models: { providers: { openrouter: { baseUrl, models: [modelEntry] } } },
    });
    const resolve = (config: OpenClawConfig) => {
      const context = resolveModelPricingContext(config);
      return resolveModelPricing(context, context.normalizeKey("openrouter", model));
    };
    expect(resolve(configWith("https://openrouter.ai/api/v1"))).toEqual(rates);
    expect(
      resolve({
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              models: [
                entry,
                { ...entry, id: "openai/gpt-catalog", baseUrl: "http://127.0.0.1:8080/v1" },
              ],
            },
          },
        },
      }),
    ).toEqual(rates);
    expect(resolve(configWith("http://127.0.0.1:8080/v1"))).toBeUndefined();
    expect(
      resolve(
        configWith("https://openrouter.ai/api/v1", {
          ...entry,
          baseUrl: "http://127.0.0.1:8080/v1",
        }),
      ),
    ).toBeUndefined();
    for (const input of [0, 9]) {
      const cost = { input, output: input, cacheRead: 0, cacheWrite: 0 };
      expect(
        resolveModelCostConfig({
          config: configWith("https://openrouter.ai/api/v1", { ...entry, cost }),
          agentDir,
          provider: "openrouter",
          model,
        }),
      ).toEqual(cost);
    }
  });

  it("retains exact shortcut prices and does not strip distinct or nested variants", () => {
    const agentDir = tempDirs.make("openclaw-routing-variants-");
    hostedPricing["openrouter/openai/gpt-catalog:nitro"] = { input: 7, output: 8 };
    hostedPricing["openrouter/openai/gpt-catalog:free"] = { input: 3, output: 4 };
    const config: OpenClawConfig = {
      models: {
        providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [] } },
      },
    };
    const resolve = (model: string, provider = "openrouter") =>
      resolveModelCostConfig({ config, agentDir, provider, model });
    expect(resolve("openai/gpt-catalog:nitro")).toEqual({
      input: 7,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(resolve("openai/gpt-catalog:free")).toEqual({
      input: 3,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
    });
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

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-v2-standalone-"));
    resetUsageFormatCachesForTest();
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
            id: "router",
            providers: ["router"],
            modelPricing: { providers: { router: { openRouter: passthrough, liteLLM: false } } },
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
          {
            id: "owner",
            providers: ["owner"],
            modelPricing: { providers: { owner: { openCode: {} } } },
          },
        ],
      }),
    );
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 100,
      readStoredCatalog: () => ({
        id: 1,
        source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
        bundle_json: JSON.stringify({
          schemaVersion: 2,
          generatedAt: 200,
          sourceCommit: "v2-standalone-test",
          providers: { vendor: {} },
          models: [
            { id: "catalogued", provider: "vendor", pricing: { status: "unknown" } },
            {
              id: "rowpriced",
              provider: "vendor",
              pricing: {
                status: "known",
                currency: "USD",
                unit: "million_tokens",
                input: 4,
                output: 20,
              },
            },
          ],
          upstreamPricing: {
            "vendor/listed": {
              input: 2,
              output: 4,
              source: "openRouter",
              alternatives: [{ input: 2.5, output: 5, source: "liteLLM" }],
            },
            "vendor/litellm-only": { input: 1, output: 3, source: "liteLLM" },
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
            "vendor/own": { input: 1, output: 2, source: "openRouter" },
          },
          providerPricing: {
            "owner/free": { input: 0, output: 0, source: "openCode" },
            "gateway/vendor/own": { input: 3, output: 9, source: "modelsDev" },
            // A mirror's standalone rate colliding with an unknown catalog row.
            "vendor/catalogued": { input: 7, output: 7, source: "modelsDev" },
          },
        }),
        generated_at: 200,
        min_version: null,
        etag: null,
        last_modified: null,
        checked_at: 200,
      }),
    });
  });

  afterEach(() => {
    resetUsageFormatCachesForTest();
    setRemoteModelCatalogOverlaySourcesForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const rates = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

  it.each([
    {
      name: "unknown catalog row is not revived by upstream or a colliding standalone rate",
      ref: "vendor/catalogued",
    },
    {
      name: "gateway uses the vendor's own row over an upstream promotion",
      ref: "gateway/vendor/rowpriced",
      cost: rates(4, 20),
    },
    {
      name: "LiteLLM-only gateway uses the LiteLLM alternative",
      ref: "litegate/vendor/listed",
      cost: rates(2.5, 5),
    },
  ])("$name", ({ ref, cost }) => {
    const slash = ref.indexOf("/");
    expect(
      resolveModelCostConfig({
        config: {},
        provider: ref.slice(0, slash),
        model: ref.slice(slash + 1),
      }),
    ).toEqual(cost);
  });
});

describe("inline v2 pricing", () => {
  const known = { status: "known", currency: "USD", unit: "million_tokens" } as const;
  let pricing: RemoteModelCatalogPricingV2;

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-v2-pricing-"));
    resetUsageFormatCachesForTest();
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
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 100,
      readStoredCatalog: () => ({
        id: 1,
        source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
        bundle_json: JSON.stringify({
          schemaVersion: 2,
          generatedAt: 200,
          sourceCommit: "v2-pricing-test",
          providers: { fixture: { defaultModel: "native/model" }, other: {} },
          models: [
            { id: "native/model", provider: "fixture", pricing },
            { id: "native/model", provider: "other", pricing: { ...known, input: 7, output: 14 } },
          ],
        }),
        generated_at: 200,
        min_version: null,
        etag: null,
        last_modified: null,
        checked_at: 200,
      }),
    });
  });

  afterEach(() => {
    resetUsageFormatCachesForTest();
    setRemoteModelCatalogOverlaySourcesForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

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
  }>)("uses $name pricing without reviving the bundled price", ({ price, expected }) => {
    pricing = price;
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

  it("does not let known zero bypass disabled external pricing", () => {
    const config: OpenClawConfig = {};
    const snapshot = pluginMetadata.resolvePluginMetadataSnapshot({ config, env: process.env });
    for (const plugin of snapshot.manifestRegistry.plugins) {
      if (plugin.id === "fixture") {
        plugin.modelPricing = { providers: { fixture: { external: false } } };
      }
    }
    expect(
      resolveModelCostConfig({ config, provider: "fixture", model: "native/model" }),
    ).toBeUndefined();
  });
});
