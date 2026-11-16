import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "../agents/embedded-agent-runner/usage-accumulator.js";
import {
  captureModelsJsonSource,
  MODELS_JSON_STATE,
  publishModelsJsonCostSource,
} from "../agents/models-config-state.js";
import { normalizeUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureEnv } from "../test-utils/env.js";
import {
  formatCostUsageCachePrefix,
  formatUsd,
  captureModelCostPricing,
  estimateAggregateUsageCost,
  estimateUsageCost,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "./usage-format.js";

type ModelCostConfig = NonNullable<Awaited<ReturnType<typeof resolveModelCostConfig>>>;
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

    expect((await resolveCost("demo-roster", "demo-model", config))?.input).toBe(42);
  });

  it("scopes models.json pricing by agent directory before configured and default pricing", async () => {
    const secondAgentDir = path.join(stateDir, "agents", "second", "agent");
    const emptyAgentDir = path.join(stateDir, "agents", "configured-only", "agent");
    await writePricing(agentDir, "demo-scoped", [pricedModel(10)]);
    await writePricing(secondAgentDir, "demo-scoped", [pricedModel(20)]);
    await fs.mkdir(emptyAgentDir, { recursive: true });

    const config = sourceConfig("demo-scoped", [pricedModel(30)]);
    using reads = vi.spyOn(fs, "readFile");
    const resolveInputPrice = async (scopedAgentDir?: string) =>
      (await resolveCost("demo-scoped", "demo-model", config, scopedAgentDir))?.input;

    expect(
      await Promise.all(
        [agentDir, secondAgentDir, emptyAgentDir, undefined].map(resolveInputPrice),
      ),
    ).toEqual([10, 20, 30, 10]);
    expect(
      reads.mock.calls.filter(([file]) => file === path.join(agentDir, "models.json")),
    ).toHaveLength(1);
  });

  const firstRates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
  const laterRates = { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0.8 };

  it("refreshes duplicate model prices and fingerprints with replacement config snapshots", async () => {
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
      expect.soft(await resolve()).toEqual(expected);
      const fingerprint = await resolveModelCostConfigFingerprint(snapshot, agentDir);
      expect.soft(fingerprint).not.toBe(previousFingerprint);
      previousFingerprint = fingerprint;
      expect.soft(await resolve()).toEqual(expected);
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
    expect(await resolve("metadata-only")).toBeUndefined();
    expect((await resolve("priced-model"))?.input).toBe(1);
    metadataOnlyModel.cost = { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 };
    expect((await resolve("metadata-only", structuredClone(config)))?.input).toBe(9);

    await writePricing(agentDir, "demo-metadata-json", [
      { id: "metadata-only" },
      { id: "priced-model", cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } },
    ]);
    publishModelsJsonCostSource(
      agentDir,
      await fs.readFile(path.join(agentDir, "models.json"), "utf8"),
    );

    expect((await resolveCost("demo-metadata-json", "priced-model"))?.input).toBe(5);
  });

  it("prepares absent and replaced pricing without synchronous filesystem calls", async () => {
    const params = {
      provider: "priced",
      model: "demo-model",
      agentDir,
      allowPluginNormalization: false,
    };
    using access = vi.spyOn(fsSync, "accessSync");
    using exists = vi.spyOn(fsSync, "existsSync");
    using lstat = vi.spyOn(fsSync, "lstatSync");
    using stat = vi.spyOn(fsSync, "statSync");
    using realpath = vi.spyOn(fsSync, "realpathSync");
    using open = vi.spyOn(fsSync, "openSync");
    using fstat = vi.spyOn(fsSync, "fstatSync");
    using read = vi.spyOn(fsSync, "readFileSync");
    for (let index = 0; index < 66; index++) {
      expect(await resolveModelCostConfig(params)).toBeUndefined();
    }
    publishModelsJsonCostSource(agentDir, "{malformed");
    expect(await resolveModelCostConfig(params)).toBeUndefined();
    await writePricing(agentDir, "priced", [pricedModel(7)]);
    publishModelsJsonCostSource(
      agentDir,
      await fs.readFile(path.join(agentDir, "models.json"), "utf8"),
    );
    expect((await resolveModelCostConfig(params))?.input).toBe(7);
    for (const call of [access, exists, lstat, stat, realpath, open, fstat, read]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("retains operation prices across cache eviction and another agent's publication", async () => {
    await writePricing(agentDir, "priced", [pricedModel(7)]);
    const captured = await captureModelCostPricing({}, agentDir);
    expect(captured.resolve("priced", "demo-model")?.input).toBe(7);
    const fingerprint = captured.fingerprint();
    for (let index = 0; index < 129; index++) {
      publishModelsJsonCostSource(path.join(stateDir, `agent-${index}`), null);
    }
    expect(MODELS_JSON_STATE.costCache.has(agentDir)).toBe(false);
    await writePricing(agentDir, "priced", [pricedModel(9)]);
    expect(
      (await captureModelCostPricing({}, agentDir)).resolve("priced", "demo-model")?.input,
    ).toBe(9);
    using lstat = vi.spyOn(fsSync, "lstatSync");
    expect(captured.resolve("priced", "demo-model")?.input).toBe(7);
    expect(captured.fingerprint()).toBe(fingerprint);
    expect(lstat).not.toHaveBeenCalled();
  });

  it("keeps the owning write newer than an overlapping source read", async () => {
    await writePricing(agentDir, "priced", [pricedModel(1)]);
    const target = path.join(agentDir, "models.json");
    const readFile = fs.readFile;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    using heldRead = vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
      const contents = await readFile(target, "utf8");
      entered.resolve();
      await release.promise;
      return contents;
    });
    const captured = captureModelsJsonSource(agentDir);
    await entered.promise;
    let writeStarted = false;
    const writing = MODELS_JSON_STATE.writeQueue.enqueue(target, async () => {
      writeStarted = true;
      await writePricing(agentDir, "priced", [pricedModel(9)]);
      publishModelsJsonCostSource(agentDir, await readFile(target, "utf8"));
    });
    try {
      await nextTurn();
      // Reproduce a late read after a committed write if the read bypasses its owner queue.
      if (writeStarted) {
        await writing;
      }
    } finally {
      release.resolve();
      await Promise.all([captured, writing]);
    }
    expect((await captured).pricing.providers?.priced?.models[0]?.cost?.input).toBe(1);
    expect((await resolveCost("priced", "demo-model", undefined, agentDir))?.input).toBe(9);
    expect(heldRead).toHaveBeenCalledTimes(1);
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
  ] as const)("preserves aggregate call-tier pricing: %j", async (usage, tiered, expected) => {
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
        cost: await resolveModelCostConfig({
          provider: "fixture",
          model: "priced",
          agentDir: "/missing-aggregate-cost-test-agent",
          allowPluginNormalization: false,
          config,
        }),
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
