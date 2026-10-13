import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as modelPricing from "../model-catalog/pricing.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  createUsageCostResolver,
  prepareUsageCostPricing,
} from "./session-cost-usage-pricing-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setRemoteModelCatalogOverlaySourcesForTest();
});

it("keeps one usage operation's prices and fingerprint when pricing is republished", async () => {
  const agentDir = tempDirs.make("openclaw-operation-pricing-");
  vi.stubEnv("OPENCLAW_STATE_DIR", agentDir);
  vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync").mockResolvedValue(
    createPluginMetadataSnapshotFixture(),
  );
  const prepareContext = async (config: OpenClawConfig, multiplier: number) => {
    const generatedAt = 200 + multiplier;
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 100,
      readStoredCatalog: () => ({
        id: 1,
        generated_at: generatedAt,
        min_version: null,
        source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
        etag: null,
        last_modified: null,
        checked_at: generatedAt,
        bundle_json: JSON.stringify({
          schemaVersion: 1,
          generatedAt,
          sourceCommit: "operation-pricing",
          providers: {},
          pricing: {
            "openai/first": { input: 2.5 * multiplier, output: 10 * multiplier },
            "openai/second": { input: 4 * multiplier, output: 8 * multiplier },
          },
        }),
      }),
    });
    await modelPricing.prepareModelPricingContext(config);
    return modelPricing.resolveModelPricingContext(config);
  };
  const config: OpenClawConfig = {};
  const original = await prepareContext(config, 1);
  const next = await prepareContext({}, 10);
  const publication = vi
    .spyOn(modelPricing, "resolveModelPricingContext")
    .mockReturnValue(original);
  const operation = await prepareUsageCostPricing(config, agentDir);
  const fingerprint = operation.fingerprint();
  const resolveCost = createUsageCostResolver({ config, agentDir }, operation);
  expect(resolveCost({ provider: "openai", model: "first" })?.input).toBe(2.5);

  publication.mockReturnValue(next);
  // This model has not been looked up or memoized by the original operation.
  expect(resolveCost({ provider: "openai", model: "second" })?.input).toBe(4);
  expect(operation.fingerprint()).toBe(fingerprint);
  const nextOperation = await prepareUsageCostPricing(config, agentDir);
  const nextResolveCost = createUsageCostResolver({ config, agentDir }, nextOperation);
  expect(nextResolveCost({ provider: "openai", model: "first" })?.input).toBe(25);
  expect(nextResolveCost({ provider: "openai", model: "second" })?.input).toBe(40);
  expect(nextOperation.fingerprint()).not.toBe(fingerprint);
});
