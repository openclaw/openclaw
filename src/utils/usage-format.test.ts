import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "../agents/embedded-agent-runner/usage-accumulator.js";
import { MODELS_JSON_STATE } from "../agents/models-config-state.js";
import { normalizeUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { captureEnv } from "../test-utils/env.js";
import {
  formatCostUsageCachePrefix,
  formatUsd,
  estimateAggregateUsageCost,
  estimateUsageCost,
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

  it.each([
    [
      "refreshing",
      0,
      1,
      "Usage totals may be incomplete (refreshing). Run this command again later.\n",
    ],
    ["fresh", 1, 0, ""],
  ] as const)("formats the %s cache notice", (status, cachedFiles, pendingFiles, expected) => {
    expect(formatCostUsageCachePrefix({ status, cachedFiles, pendingFiles, staleFiles: 0 })).toBe(
      expected,
    );
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
      resolveModelCostConfig({ provider: "demo-metadata-json", model: "priced-model" })?.input,
    ).toBe(5);
  });
});

function promptPricing(): ModelCostConfig {
  const baseRates = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 };
  return {
    ...baseRates,
    tieredPricing: [
      { ...baseRates, range: [0, 100] },
      { input: 3, output: 6, cacheRead: 1, cacheWrite: 2, range: [100, Infinity] },
    ],
  };
}

const unpriced = {
  provider: "unpriced-fixture",
  model: "unpriced",
  config: {},
  allowPluginNormalization: false,
};

describe("usage cost estimation", () => {
  it("never reprices an incomplete mixed-model total after another aggregation", () => {
    const attempt = createUsageAccumulator();
    mergeUsageIntoAccumulator(attempt, { input: 100, costStatus: "unavailable" });
    mergeUsageIntoAccumulator(attempt, {
      input: 200,
      cost: { total: 0.7 },
      costStatus: "complete",
    });
    const run = createUsageAccumulator();
    mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
    expect(toNormalizedUsage(run)?.input).toBe(300);
    expect(
      estimateAggregateUsageCost({
        usage: toNormalizedUsage(run),
        cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ input: 1_000, cost: { total: 0 } }, true, 0],
    [{ input: 1_000 }, true, undefined],
    [{ total: 1_000 }, false, undefined],
  ] as const)("preserves aggregate call-tier pricing: %j", (usage, tiered, expected) => {
    const rates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
    const cost: ModelCostConfig = {
      ...rates,
      tieredPricing: tiered ? [{ ...rates, range: [0, Infinity] }] : undefined,
    };
    const config = pricingConfig("fixture", [pricingModel("priced", cost)]);
    expect(estimateAggregateUsageCost({ usage, cost })).toBe(expected);
    expect(
      estimateAggregateUsageCost({
        usage,
        provider: "fixture",
        model: "priced",
        agentDir: "/missing-aggregate-cost-test-agent",
        allowPluginNormalization: false,
        config,
      }),
    ).toBe(expected);
  });

  it("preserves provider-billed zero for unpriced aggregate usage", () => {
    expect(
      estimateAggregateUsageCost({
        usage: { input: 1_000, output: 500, cost: { total: 0, totalOrigin: "provider-billed" } },
        ...unpriced,
      }),
    ).toBe(0);
  });

  it("keeps recorded zero components through nested sums without covering an unpriced call", () => {
    const recorded = normalizeUsage({ input: 1_000, cost: { total: 0, input: 0.25 } });
    const attempt = createUsageAccumulator();
    mergeUsageIntoAccumulator(attempt, recorded);
    const run = createUsageAccumulator();
    mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
    const total = () => estimateAggregateUsageCost({ ...unpriced, usage: toNormalizedUsage(run) });
    expect(total()).toBe(0);
    expect(toNormalizedUsage(run)?.cost?.totalOrigin).toBeUndefined();

    mergeUsageIntoAccumulator(run, normalizeUsage({ input: 1_000, cost: { total: 0 } }));
    expect(total()).toBeUndefined();
    mergeUsageIntoAccumulator(run, recorded);
    expect(total()).toBeUndefined();
  });

  it.each([
    [{ input: 100 }, { input: 0.042, output: 0 }, 0.0000042],
    [{ input: 100, output: 0 }, { input: 0 }, 0],
    [{ input: 100 }, { input: 0.042, output: 1 }, undefined],
    [{ input: 100, output: 1 }, { input: 0.042 }, undefined],
    [{ total: 100 }, { input: 0, output: 0 }, undefined],
    [{ input: -1 }, { input: 0, output: 0 }, undefined],
  ] as const)("requires known charged buckets: %j", (usage, declaredCost, expected) => {
    const cost = estimateUsageCost({
      usage,
      declaredCost: { cacheRead: 0, cacheWrite: 0, ...declaredCost },
    });
    if (expected === undefined || expected === 0) {
      expect(cost).toBe(expected);
    } else {
      expect(cost).toBeCloseTo(expected, 15);
    }
  });

  it("uses the selected input rate for the 1h cache-write subset", () => {
    const usage = { input: 20, output: 10, cacheRead: 30, cacheWrite: 60, cacheWrite1h: 40 };
    expect(estimateUsageCost({ usage, cost: promptPricing() })).toBeCloseTo(0.00043, 10);
  });
});
