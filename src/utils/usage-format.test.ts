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
function accumulate(...usages: Parameters<typeof mergeUsageIntoAccumulator>[1][]) {
  const result = createUsageAccumulator();
  for (const usage of usages) {
    mergeUsageIntoAccumulator(result, usage);
  }
  return result;
}

const inputRates = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
type SourceModel = { id: string; cost?: Partial<ModelDefinitionConfig["cost"]> };
function sourceConfig(provider: string, models: SourceModel[]): OpenClawConfig {
  return { models: { providers: { [provider]: { models } } } } as unknown as OpenClawConfig;
}
const pricedModel = (input: number) => ({ id: "demo-model", cost: inputRates(input) });
const resolveCost = (provider: string, model: string, config?: OpenClawConfig, agentDir?: string) =>
  resolveModelCostConfig({ provider, model, config, agentDir });

async function writePricing(agentDir: string, provider: string, models: SourceModel[]) {
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
    ["refreshing", "Usage totals may be incomplete (refreshing). Run this command again later.\n"],
    ["fresh", ""],
  ] as const)("formats the %s cache notice", (status, expected) => {
    expect(
      formatCostUsageCachePrefix({ status, cachedFiles: 1, pendingFiles: 0, staleFiles: 0 }),
    ).toBe(expected);
  });

  it("uses the sole agent directory from a canonical roster", async () => {
    const opsAgentDir = path.join(stateDir, "custom-ops-agent");
    await writePricing(opsAgentDir, "demo-roster", [pricedModel(42)]);
    const config = {
      agents: { entries: { ops: { agentDir: opsAgentDir } } },
    } satisfies OpenClawConfig;

    expect(resolveCost("demo-roster", "demo-model", config)?.input).toBe(42);
  });

  it("scopes models.json pricing by agent directory before configured and default pricing", async () => {
    const secondAgentDir = path.join(stateDir, "agents", "second", "agent");
    const emptyAgentDir = path.join(stateDir, "agents", "configured-only", "agent");
    await writePricing(agentDir, "demo-scoped", [pricedModel(10)]);
    await writePricing(secondAgentDir, "demo-scoped", [pricedModel(20)]);
    await fs.mkdir(emptyAgentDir, { recursive: true });

    const config = sourceConfig("demo-scoped", [pricedModel(30)]);
    const resolveInputPrice = (scopedAgentDir?: string) =>
      resolveCost("demo-scoped", "demo-model", config, scopedAgentDir)?.input;

    expect([agentDir, secondAgentDir, emptyAgentDir, undefined].map(resolveInputPrice)).toEqual([
      10, 20, 30, 10,
    ]);
  });

  const firstRates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
  const laterRates = { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0.8 };

  it("refreshes duplicate model prices and fingerprints with replacement config snapshots", () => {
    const partial = { output: 0 };
    let previousFingerprint: string | undefined;
    const snapshots: [Array<SourceModel["cost"]>, ModelCostConfig | undefined][] = [
      [[firstRates, laterRates], firstRates],
      [[undefined, laterRates], laterRates],
      [[partial, laterRates], { ...laterRates, output: 0 }],
      [[laterRates, partial, firstRates], laterRates],
      [[], undefined],
    ];
    for (const [costs, expected] of snapshots) {
      const snapshot = sourceConfig(
        "venice",
        costs.map((cost) => ({ id: "priced-fixture", cost })),
      );
      const resolve = () => resolveCost("venice", "priced-fixture", snapshot, agentDir);
      expect.soft(resolve()).toEqual(expected);
      const fingerprint = resolveModelCostConfigFingerprint(snapshot, agentDir);
      expect.soft(fingerprint).not.toBe(previousFingerprint);
      previousFingerprint = fingerprint;
      expect.soft(resolve()).toEqual(expected);
    }
  });

  it("skips metadata-only model rows while caching configured pricing", async () => {
    const metadataOnlyModel: SourceModel = { id: "metadata-only" };
    const config = sourceConfig("demo-metadata-row", [
      metadataOnlyModel,
      { id: "priced-model", cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    ]);
    const resolve = (model: string, snapshot = config) =>
      resolveCost("demo-metadata-row", model, snapshot);
    expect(resolve("metadata-only")).toBeUndefined();
    expect(resolve("priced-model")?.input).toBe(1);
    metadataOnlyModel.cost = { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 };
    expect(resolve("metadata-only", structuredClone(config))?.input).toBe(9);

    await writePricing(agentDir, "demo-metadata-json", [
      { id: "metadata-only" },
      { id: "priced-model", cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } },
    ]);

    expect(resolveCost("demo-metadata-json", "priced-model")?.input).toBe(5);
  });
});

const unpriced = {
  provider: "unpriced-fixture",
  model: "unpriced",
  config: {},
  allowPluginNormalization: false,
};

describe("usage cost estimation", () => {
  it("never reprices an incomplete mixed-model total after another aggregation", () => {
    const attempt = accumulate(
      { input: 100, costStatus: "unavailable" },
      { input: 200, cost: { total: 0.7 }, costStatus: "complete" },
    );
    const usage = toNormalizedUsage(accumulate(toNormalizedUsage(attempt)));
    expect(usage?.input).toBe(300);
    expect(estimateAggregateUsageCost({ usage, cost: inputRates(10) })).toBeUndefined();
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
    const config = sourceConfig("fixture", [{ id: "priced", cost }]);
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
    const run = accumulate(toNormalizedUsage(accumulate(recorded)));
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
    expect(cost).toEqual(expected ? expect.closeTo(expected, 15) : expected);
  });

  it("uses the selected input rate for the 1h cache-write subset", () => {
    const rates = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 };
    const cost: ModelCostConfig = {
      ...rates,
      tieredPricing: [
        { ...rates, range: [0, 100] },
        { input: 3, output: 6, cacheRead: 1, cacheWrite: 2, range: [100, Infinity] },
      ],
    };
    const usage = { input: 20, output: 10, cacheRead: 30, cacheWrite: 60, cacheWrite1h: 40 };
    expect(estimateUsageCost({ usage, cost })).toBeCloseTo(0.00043, 10);
  });
});
