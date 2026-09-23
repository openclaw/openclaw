import type { RemoteModelCatalogPricing } from "@openclaw/model-catalog-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeManifestModelPricing } from "../plugins/manifest-model-provider-normalizers.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { resetUsageFormatCachesForTest, resolveModelCostConfig } from "../utils/usage-format.js";
import { resolveModelPricing, resolveModelPricingContext } from "./pricing.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
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

describe("OpenRouter routing shortcut estimates", () => {
  it.each(["nitro", "floor"])(
    "prices the OpenRouter :%s shortcut after endpoint checks",
    (suffix) => {
      const agentDir = tempDirs.make("openclaw-routing-pricing-");
      const model = `openai/gpt-catalog:${suffix}`;
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
    },
  );

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

  it("does not use a routing shortcut to revive disabled external pricing", () => {
    const agentDir = tempDirs.make("openclaw-routing-policy-");
    const config: OpenClawConfig = {
      plugins: { allow: ["openrouter"], entries: { openrouter: { enabled: true } } },
    };
    const snapshot = pluginMetadata.resolvePluginMetadataSnapshot({ config, env: process.env });
    const plugins = snapshot.manifestRegistry.plugins.map((plugin) =>
      plugin.id === "openrouter"
        ? {
            ...plugin,
            modelCatalog: {
              providers: {
                openrouter: {
                  models: [{ id: "openai/gpt-catalog", cost: { input: 1, output: 2 } }],
                },
              },
            },
            modelPricing: normalizeManifestModelPricing(
              { providers: { openrouter: { external: false } } },
              { ownedProviders: new Set(["openrouter"]) },
            ),
          }
        : plugin,
    );
    vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockReturnValue({
      ...snapshot,
      manifestRegistry: { ...snapshot.manifestRegistry, plugins },
    });
    expect(
      resolveModelCostConfig({
        config,
        agentDir,
        provider: "openrouter",
        model: "openai/gpt-catalog",
      }),
    ).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    for (const suffix of ["nitro", "floor"]) {
      expect(
        resolveModelCostConfig({
          config,
          agentDir,
          provider: "openrouter",
          model: `openai/gpt-catalog:${suffix}`,
        }),
      ).toBeUndefined();
    }
  });
});
