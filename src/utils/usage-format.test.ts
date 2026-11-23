import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "../agents/embedded-agent-runner/usage-accumulator.js";
import { normalizeUsage } from "../agents/usage.js";
import {
  formatCostUsageCachePrefix,
  formatUsd,
  estimateAggregateUsageCost,
  estimateUsageCost,
  type ModelCostConfig,
} from "./usage-format.js";

function accumulate(...usages: Parameters<typeof mergeUsageIntoAccumulator>[1][]) {
  const result = createUsageAccumulator();
  for (const usage of usages) {
    mergeUsageIntoAccumulator(result, usage);
  }
  return result;
}

const inputRates = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

describe("usage-format", () => {
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

  it("prices an all-zero transport cost from the resolved price, keeping authored zero", () => {
    const usage = { input: 1_000, output: 500, cost: { total: 0 } };
    expect(
      estimateAggregateUsageCost({
        usage,
        cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toBeCloseTo(0.007, 10);
    expect(estimateAggregateUsageCost({ usage, cost: inputRates(0) })).toBe(0);
  });

  it("prices a tiered sum only while every call stays in the first tier", () => {
    const rates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
    const cost: ModelCostConfig = {
      ...rates,
      tieredPricing: [
        { ...rates, range: [0, 200] },
        { input: 3, output: 6, cacheRead: 1, cacheWrite: 0, range: [200, Infinity] },
      ],
    };
    expect(estimateAggregateUsageCost({ usage: { input: 150, output: 10 }, cost })).toBeCloseTo(
      0.00017,
      10,
    );
    expect(
      estimateAggregateUsageCost({ usage: { input: 150, cacheRead: 50 }, cost }),
    ).toBeUndefined();
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
