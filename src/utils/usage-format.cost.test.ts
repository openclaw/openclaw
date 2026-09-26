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

type PricingTier = NonNullable<ModelCostConfig["tieredPricing"]>[number];

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
    { name: "cost-only fact", usage: { cost: { total: 0.75 } }, tiered: true, expected: 0.75 },
    { name: "missing tiered cost", usage: { input: 1_000 }, tiered: true, expected: undefined },
    { name: "flat fallback", usage: { input: 1_000 }, tiered: false, expected: 0.001 },
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

  it.each([
    { name: "adapter zero", cost: { total: 0 }, expected: undefined },
    {
      name: "billed zero",
      cost: { total: 0, totalOrigin: "provider-billed" as const },
      expected: 0,
    },
    { name: "recorded positive estimate", cost: { total: 0.25 }, expected: 0.25 },
  ])("reports unpriced aggregate usage only with cost evidence: $name", ({ cost, expected }) => {
    expect(
      estimateAggregateUsageCost({
        usage: { input: 1_000, output: 500, cost },
        provider: "unpriced-fixture",
        model: "unpriced",
        config: {},
        allowPluginNormalization: false,
      }),
    ).toBe(expected);
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

  it.each([
    { name: "below boundary", input: 40, cacheRead: 30, cacheWrite: 29, expected: 0.000082 },
    { name: "at boundary", input: 40, cacheRead: 30, cacheWrite: 30, expected: 0.00027 },
    { name: "fully cached", input: 0, cacheRead: 100, cacheWrite: 0, expected: 0.00016 },
    { name: "fully written", input: 0, cacheRead: 0, cacheWrite: 100, expected: 0.00026 },
  ])(
    "selects the whole-request tier from prompt buckets: $name",
    ({ input, cacheRead, cacheWrite, expected }) => {
      expect(
        estimateUsageCost({
          usage: { input, output: 10, cacheRead, cacheWrite },
          cost: promptPricing(),
        }),
      ).toBeCloseTo(expected, 10);
    },
  );

  it("uses the selected input rate for the 1h cache-write subset", () => {
    const usage = { input: 20, output: 10, cacheRead: 30, cacheWrite: 60, cacheWrite1h: 40 };
    expect(estimateUsageCost({ usage, cost: promptPricing() })).toBeCloseTo(0.00043, 10);
  });

  it("uses first tier rates for output when input is zero", () => {
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    const total = estimateUsageCost({
      usage: { input: 0, output: 10_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.015, 6);
  });

  it("falls back to flat pricing when tieredPricing is empty array", () => {
    const cost: ModelCostConfig = {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0,
      tieredPricing: [],
    };
    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });
    expect(total).toBeCloseTo(0.003);
  });

  it("bills overflow input tokens at last tier rate when input exceeds max range", () => {
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    const total = estimateUsageCost({
      usage: { input: 200_000, output: 10_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.125, 4);
  });

  it("uses declared tier ranges instead of sequential widths", () => {
    const tiers: PricingTier[] = [
      { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, range: [100, 200] },
      { input: 2, output: 20, cacheRead: 0, cacheWrite: 0, range: [0, 100] },
    ];
    const cost = { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    const total = estimateUsageCost({
      usage: { input: 150, output: 60 },
      cost,
    });

    expect(total).toBeCloseTo(0.00075, 8);
  });
});
