import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODELS_JSON_STATE } from "../agents/models-config-state.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import * as manifestModelIdNormalization from "../plugins/manifest-model-id-normalization.js";
import { captureEnv } from "../test-utils/env.js";
import {
  formatCostUsageCachePrefix,
  formatUsd,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "./usage-format.js";

type ModelCostConfig = NonNullable<ReturnType<typeof resolveModelCostConfig>>;

function pricingModel(id: string, cost: ModelDefinitionConfig["cost"]): ModelDefinitionConfig {
  return { id, name: id, reasoning: false, input: ["text"], maxTokens: 1, cost };
}

function pricingConfig(provider: string, models: ModelDefinitionConfig[]): OpenClawConfig {
  return {
    models: { providers: { [provider]: { baseUrl: "https://fixture.invalid", models } } },
  };
}

const inputRates = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
type SourceModel = { id: string; cost?: Partial<ModelDefinitionConfig["cost"]> };
function sourceConfig(provider: string, models: SourceModel[]): OpenClawConfig {
  return { models: { providers: { [provider]: { models } } } } as unknown as OpenClawConfig;
}

async function writePricing(
  agentDir: string,
  provider: string,
  models: SourceModel[],
): Promise<void> {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { [provider]: { models } } }),
    "utf8",
  );
}

describe("usage-format", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let agentDir: string;
  let stateDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-format-"));
    agentDir = path.join(stateDir, "agents", "main", "agent");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_AGENT_DIR;
    await fs.mkdir(agentDir, { recursive: true });
    MODELS_JSON_STATE.costCache.clear();
  });

  afterEach(async () => {
    envSnapshot?.restore();
    envSnapshot = undefined;
    MODELS_JSON_STATE.costCache.clear();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("formats USD values", () => {
    expect([1.234, 0.5, 0.0042].map(formatUsd)).toEqual(["$1.23", "$0.50", "$0.0042"]);
  });

  it("formats the refreshing cache notice", () => {
    expect(
      formatCostUsageCachePrefix({
        status: "refreshing",
        cachedFiles: 0,
        pendingFiles: 1,
        staleFiles: 0,
      }),
    ).toBe("Usage totals may be incomplete (refreshing). Run this command again later.\n");
    expect(
      formatCostUsageCachePrefix({
        status: "fresh",
        cachedFiles: 1,
        pendingFiles: 0,
        staleFiles: 0,
      }),
    ).toBe("");
  });

  it("uses the sole agent directory from a canonical roster", async () => {
    const opsAgentDir = path.join(stateDir, "custom-ops-agent");
    await writePricing(opsAgentDir, "demo-roster", [pricingModel("demo-model", inputRates(42))]);
    const config = {
      agents: { entries: { ops: { agentDir: opsAgentDir } } },
    } satisfies OpenClawConfig;

    expect(
      resolveModelCostConfig({ provider: "demo-roster", model: "demo-model", config })?.input,
    ).toBe(42);
  });

  it("scopes models.json pricing by agent directory before configured and default pricing", async () => {
    const secondAgentDir = path.join(stateDir, "agents", "second", "agent");
    const configuredOnlyAgentDir = path.join(stateDir, "agents", "configured-only", "agent");
    await writePricing(agentDir, "demo-scoped", [pricingModel("demo-model", inputRates(10))]);
    await writePricing(secondAgentDir, "demo-scoped", [pricingModel("demo-model", inputRates(20))]);
    await fs.mkdir(configuredOnlyAgentDir, { recursive: true });

    const config = pricingConfig("demo-scoped", [pricingModel("demo-model", inputRates(30))]);
    const resolveInputPrice = (scopedAgentDir?: string) =>
      resolveModelCostConfig({
        provider: "demo-scoped",
        model: "demo-model",
        config,
        agentDir: scopedAgentDir,
      })?.input;

    expect(
      [agentDir, secondAgentDir, configuredOnlyAgentDir, undefined].map(resolveInputPrice),
    ).toEqual([10, 20, 30, 10]);
  });

  it("skips manifest model normalization for raw cost lookup", () => {
    const manifestSpy = vi.spyOn(
      manifestModelIdNormalization,
      "resolveManifestModelIdNormalizationPolicies",
    );
    const rates = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const config = pricingConfig("demo-raw", [pricingModel("demo-model", { ...rates })]);

    const resolveRaw = (provider: string, model: string) =>
      resolveModelCostConfig({ provider, model, config, allowPluginNormalization: false });
    expect(resolveRaw("demo-raw", "demo-model")).toEqual(rates);
    expect(resolveRaw("anthropic", "missing-model")).toBeUndefined();
    expect(manifestSpy).not.toHaveBeenCalled();
  });

  const firstRates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
  const laterRates = { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0.8 };

  it("refreshes duplicate model prices and fingerprints with replacement config snapshots", () => {
    const first: SourceModel = { id: "priced-fixture", cost: { ...firstRates } };
    const later: SourceModel = { id: "priced-fixture", cost: { ...laterRates } };
    const models = [first, later];
    const config = sourceConfig("venice", models);
    let previousFingerprint: string | undefined;
    const check = (label: string, expected: ModelCostConfig | undefined) => {
      const snapshot = structuredClone(config);
      const resolve = () =>
        resolveModelCostConfig({
          config: snapshot,
          agentDir,
          provider: "venice",
          model: "priced-fixture",
        });
      expect.soft(resolve(), label).toEqual(expected);
      const fingerprint = resolveModelCostConfigFingerprint(snapshot, agentDir);
      expect.soft(fingerprint, label).not.toBe(previousFingerprint);
      previousFingerprint = fingerprint;
      // Fingerprinting and direct lookups share this snapshot's prices.
      expect.soft(resolve(), label).toEqual(expected);
    };
    check("initial duplicates", firstRates);
    first.cost!.input = 9;
    check("mutated first cost", { ...firstRates, input: 9 });
    delete first.cost;
    check("removed first cost", laterRates);
    first.cost = { output: 0 };
    check("restored partial cost", { ...laterRates, output: 0 });
    const inserted = { id: "priced-fixture", cost: { ...firstRates, input: 3 } };
    models.unshift(inserted);
    check("inserted duplicate", inserted.cost);
    models.reverse();
    check("reordered duplicates", laterRates);
    models[0] = { id: "priced-fixture", cost: { ...firstRates, input: 4 } };
    check("replaced same-id row", { ...firstRates, input: 4 });
    models.shift();
    check("removed duplicate", { ...inserted.cost, output: 0 });
    models.splice(0);
    check("removed all rows", undefined);
  });

  it("skips metadata-only model rows while caching configured pricing", async () => {
    const metadataOnlyModel: SourceModel = { id: "metadata-only" };
    const config = sourceConfig("demo-metadata-row", [
      metadataOnlyModel,
      { id: "priced-model", cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    ]);
    const resolve = (model: string, snapshot = config) =>
      resolveModelCostConfig({ provider: "demo-metadata-row", model, config: snapshot });
    expect(resolve("metadata-only")).toBeUndefined();
    expect(resolve("priced-model")?.input).toBe(1);
    metadataOnlyModel.cost = { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 };
    expect(resolve("metadata-only", structuredClone(config))?.input).toBe(9);

    await writePricing(agentDir, "demo-metadata-json", [
      { id: "metadata-only" },
      { id: "priced-model", cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-json",
        model: "priced-model",
      })?.input,
    ).toBe(5);
  });
});
