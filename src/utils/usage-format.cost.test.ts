import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "../agents/embedded-agent-runner/usage-accumulator.js";
import { normalizeUsage } from "../agents/usage.js";
import {
  estimateAggregateUsageCost,
  estimateUsageCost,
  type ModelCostConfig,
} from "./usage-format.js";

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
    const model = {
      id: "priced",
      name: "Priced",
      reasoning: false,
      input: ["text" as const],
      maxTokens: 1,
      cost,
    };
    const fixture = { baseUrl: "https://fixture.invalid", models: [model] };
    expect(estimateAggregateUsageCost({ usage, cost })).toBe(expected);
    expect(
      estimateAggregateUsageCost({
        usage,
        provider: "fixture",
        model: "priced",
        agentDir: "/missing-aggregate-cost-test-agent",
        allowPluginNormalization: false,
        config: { models: { providers: { fixture } } },
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
