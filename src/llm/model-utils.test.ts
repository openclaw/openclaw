import { describe, expect, it } from "vitest";
import { calculateCost } from "./model-utils.js";
import type { Model, Usage } from "./types.js";

function createUsage(overrides: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

describe("calculateCost", () => {
  it("uses tiered pricing based on input token count", () => {
    const model = {
      id: "MiniMax-M3",
      name: "MiniMax M3",
      api: "anthropic-messages",
      provider: "minimax",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.6,
        output: 2.4,
        cacheRead: 0.12,
        cacheWrite: 0,
        tieredPricing: [
          { range: [0, 512_000], input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
          { range: [512_000], input: 1.2, output: 4.8, cacheRead: 0.24, cacheWrite: 0 },
        ],
      },
      contextWindow: 1_000_000,
      maxTokens: 131072,
    } as Model<"anthropic-messages">;

    const lowerTierUsage = createUsage({
      input: 400_000,
      output: 10_000,
      cacheRead: 100_000,
    });
    const higherTierUsage = createUsage({
      input: 600_000,
      output: 10_000,
      cacheRead: 100_000,
    });

    calculateCost(model, lowerTierUsage);
    calculateCost(model, higherTierUsage);

    expect(lowerTierUsage.cost.input).toBeCloseTo(0.24);
    expect(lowerTierUsage.cost.output).toBeCloseTo(0.024);
    expect(lowerTierUsage.cost.cacheRead).toBeCloseTo(0.012);
    expect(lowerTierUsage.cost.cacheWrite).toBeCloseTo(0);
    expect(lowerTierUsage.cost.total).toBeCloseTo(0.276);
    expect(higherTierUsage.cost.input).toBeCloseTo(0.72);
    expect(higherTierUsage.cost.output).toBeCloseTo(0.048);
    expect(higherTierUsage.cost.cacheRead).toBeCloseTo(0.024);
    expect(higherTierUsage.cost.cacheWrite).toBeCloseTo(0);
    expect(higherTierUsage.cost.total).toBeCloseTo(0.792);
  });
});
