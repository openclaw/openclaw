import type { RemoteModelCatalogPricingV2 } from "@openclaw/model-catalog-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetUsageFormatCachesForTest, resolveModelCostConfig } from "../utils/usage-format.js";
import { resolveModelPricing, resolveModelPricingContext } from "./pricing.js";
import { getRemoteModelCatalogProviderOverlay } from "./remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

describe("inline v2 pricing", () => {
  it.each([
    {
      name: "positive",
      price: { ...known, input: 3, output: 6 },
      expected: { input: 3, output: 6 },
    },
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

  it.each(["disabled plugin", "private endpoint", "external disabled"])(
    "does not let known zero bypass %s",
    (scenario) => {
      const config: OpenClawConfig =
        scenario === "disabled plugin"
          ? { plugins: { entries: { fixture: { enabled: false } } } }
          : scenario === "private endpoint"
            ? {
                models: {
                  providers: { fixture: { baseUrl: "http://127.0.0.1:8080/v1", models: [] } },
                },
              }
            : {};
      if (scenario === "external disabled") {
        const snapshot = pluginMetadata.resolvePluginMetadataSnapshot({ config, env: process.env });
        for (const plugin of snapshot.manifestRegistry.plugins) {
          if (plugin.id === "fixture") {
            plugin.modelPricing = { providers: { fixture: { external: false } } };
          }
        }
      }
      expect(
        resolveModelCostConfig({ config, provider: "fixture", model: "native/model" }),
      ).toBeUndefined();
    },
  );

  it("preserves authored pricing when the remote source withdraws it", () => {
    pricing = { status: "unavailable" };
    const cost = { input: 5, output: 10, cacheRead: 1, cacheWrite: 2 };
    const config: OpenClawConfig = {
      models: {
        providers: {
          fixture: {
            baseUrl: "https://fixture.example/v1",
            models: [
              {
                id: "native/model",
                name: "Authored",
                input: ["text"],
                reasoning: false,
                maxTokens: 8192,
                cost,
              },
            ],
          },
        },
      },
    };
    expect(resolveModelCostConfig({ config, provider: "fixture", model: "native/model" })).toEqual(
      cost,
    );
  });
});
