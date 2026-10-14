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

describe("usage cost estimation", () => {
  it.each([
    {
      name: "recorded zero",
      usage: { input: 1_000, cost: { total: 0 } },
      tiered: true,
      expected: 0,
    },
    { name: "missing tiered cost", usage: { input: 1_000 }, tiered: true, expected: undefined },
    { name: "total-only usage", usage: { total: 1_000 }, tiered: false, expected: undefined },
  ])(
    "resolves aggregate cost without reconstructing call tiers: $name",
    ({ usage, tiered, expected }) => {
      const rates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
      const cost: ModelCostConfig = {
        ...rates,
        ...(tiered
          ? { tieredPricing: [{ ...rates, range: [0, Infinity] as [number, number] }] }
          : {}),
      };
      expect(estimateAggregateUsageCost({ usage, cost })).toBe(expected);
      expect(
        estimateAggregateUsageCost({
          usage,
          provider: "fixture",
          model: "priced",
          agentDir: "/missing-aggregate-cost-test-agent",
          allowPluginNormalization: false,
          config: {
            models: {
              providers: {
                fixture: {
                  baseUrl: "https://fixture.invalid",
                  models: [
                    {
                      id: "priced",
                      name: "Priced",
                      reasoning: false,
                      input: ["text"],
                      maxTokens: 1,
                      cost,
                    },
                  ],
                },
              },
            },
          },
        }),
      ).toBe(expected);
    },
  );

  it("preserves provider-billed zero for unpriced aggregate usage", () => {
    expect(
      estimateAggregateUsageCost({
        usage: { input: 1_000, output: 500, cost: { total: 0, totalOrigin: "provider-billed" } },
        provider: "unpriced-fixture",
        model: "unpriced",
        config: {},
        allowPluginNormalization: false,
      }),
    ).toBe(0);
  });

  it("keeps recorded zero components through nested sums without covering an unpriced call", () => {
    const recorded = normalizeUsage({ input: 1_000, cost: { total: 0, input: 0.25 } });
    const attempt = createUsageAccumulator();
    mergeUsageIntoAccumulator(attempt, recorded);
    const run = createUsageAccumulator();
    mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
    const pricing = {
      provider: "unpriced-fixture",
      model: "unpriced",
      config: {},
      allowPluginNormalization: false,
    };
    expect(estimateAggregateUsageCost({ ...pricing, usage: toNormalizedUsage(run) })).toBe(0);
    expect(toNormalizedUsage(run)?.cost?.totalOrigin).toBeUndefined();

    mergeUsageIntoAccumulator(run, normalizeUsage({ input: 1_000, cost: { total: 0 } }));
    expect(
      estimateAggregateUsageCost({ ...pricing, usage: toNormalizedUsage(run) }),
    ).toBeUndefined();
    mergeUsageIntoAccumulator(run, recorded);
    expect(
      estimateAggregateUsageCost({ ...pricing, usage: toNormalizedUsage(run) }),
    ).toBeUndefined();
  });

  it("uses the selected input rate for the 1h cache-write subset", () => {
    const usage = { input: 20, output: 10, cacheRead: 30, cacheWrite: 60, cacheWrite1h: 40 };
    expect(estimateUsageCost({ usage, cost: promptPricing() })).toBeCloseTo(0.00043, 10);
  });
});
