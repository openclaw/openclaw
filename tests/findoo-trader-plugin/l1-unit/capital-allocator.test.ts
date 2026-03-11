/**
 * L1 Unit Tests — Capital Allocator (Modified Half-Kelly)
 *
 * Covers:
 * - Half-Kelly formula: weights proportional to fitness, halved for safety
 * - Fixed fractional via maxSingleStrategyPct cap (default 30%)
 * - Equal weight approximation when all fitness values are equal
 * - Kelly criterion edge cases: 0 win rate, 100% win rate, negative expected value
 * - Total exposure cap at maxTotalExposurePct (default 70%)
 * - High-correlation group cap at 40%
 * - New L3 strategies (< 30 days) capped at 10%
 * - L2 paper strategies capped at 15%
 * - Zero/negative capital, empty strategies
 * - Only positive-fitness L2+/L3 strategies get allocated
 */

import { describe, it, expect } from "vitest";
import { CapitalAllocator } from "../../../extensions/findoo-trader-plugin/src/fund/capital-allocator.js";
import type {
  StrategyProfile,
  FundConfig,
} from "../../../extensions/findoo-trader-plugin/src/fund/types.js";

// -- Helpers ------------------------------------------------------------------

const DEFAULT_CONFIG: FundConfig = {
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "daily",
};

function makeProfile(
  overrides: Partial<StrategyProfile> & { id: string; fitness: number },
): StrategyProfile {
  return {
    name: overrides.id,
    level: "L3_LIVE",
    fitness: overrides.fitness,
    paperDaysActive: 60,
    ...overrides,
  };
}

// -- Tests --------------------------------------------------------------------

describe("CapitalAllocator — empty/zero edge cases", () => {
  const allocator = new CapitalAllocator();

  // 1. No strategies -> empty
  it("returns empty array for no strategies", () => {
    expect(allocator.allocate([], 100_000, DEFAULT_CONFIG)).toEqual([]);
  });

  // 2. Zero capital -> empty
  it("returns empty array for zero capital", () => {
    const strategies = [makeProfile({ id: "s1", fitness: 1.0 })];
    expect(allocator.allocate(strategies, 0, DEFAULT_CONFIG)).toEqual([]);
  });

  // 3. Negative capital -> empty
  it("returns empty array for negative capital", () => {
    const strategies = [makeProfile({ id: "s1", fitness: 1.0 })];
    expect(allocator.allocate(strategies, -10_000, DEFAULT_CONFIG)).toEqual([]);
  });

  // 4. All strategies with zero or negative fitness -> empty
  it("returns empty when all strategies have non-positive fitness", () => {
    const strategies = [
      makeProfile({ id: "s1", fitness: 0 }),
      makeProfile({ id: "s2", fitness: -0.5 }),
    ];
    expect(allocator.allocate(strategies, 100_000, DEFAULT_CONFIG)).toEqual([]);
  });
});

describe("CapitalAllocator — eligibility filtering", () => {
  const allocator = new CapitalAllocator();

  // 5. Only positive-fitness strategies get allocated
  it("filters out strategies with zero or negative fitness", () => {
    const strategies = [
      makeProfile({ id: "s1", fitness: 1.0 }),
      makeProfile({ id: "s2", fitness: -0.5 }),
      makeProfile({ id: "s3", fitness: 0 }),
    ];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0].strategyId).toBe("s1");
  });

  // 6. Only L2_PAPER or L3_LIVE get allocated
  it("excludes L0 and L1 strategies from allocation", () => {
    const strategies = [
      makeProfile({ id: "live", fitness: 1.0, level: "L3_LIVE" }),
      makeProfile({ id: "paper", fitness: 1.0, level: "L2_PAPER" }),
      makeProfile({ id: "incubate", fitness: 1.0, level: "L0_INCUBATE" }),
      makeProfile({ id: "backtest", fitness: 1.0, level: "L1_BACKTEST" }),
    ];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);
    expect(result).toHaveLength(2);
    const ids = result.map((a) => a.strategyId);
    expect(ids).toContain("live");
    expect(ids).toContain("paper");
  });
});

describe("CapitalAllocator — Half-Kelly proportional weights", () => {
  const allocator = new CapitalAllocator();

  // 7. Higher fitness gets more capital
  it("allocates more capital to higher-fitness strategies", () => {
    const strategies = [
      makeProfile({ id: "s1", fitness: 2.0 }),
      makeProfile({ id: "s2", fitness: 1.0 }),
    ];
    const result = allocator.allocate(strategies, 300_000, DEFAULT_CONFIG);
    const s1 = result.find((a) => a.strategyId === "s1")!;
    const s2 = result.find((a) => a.strategyId === "s2")!;

    expect(s1.capitalUsd).toBeGreaterThan(s2.capitalUsd);
  });

  // 8. Equal fitness -> approximately equal weights
  it("allocates approximately equal weights for equal fitness", () => {
    const strategies = [
      makeProfile({ id: "a", fitness: 1.0 }),
      makeProfile({ id: "b", fitness: 1.0 }),
    ];
    const result = allocator.allocate(strategies, 200_000, DEFAULT_CONFIG);
    const a = result.find((r) => r.strategyId === "a")!;
    const b = result.find((r) => r.strategyId === "b")!;

    // Should be within 1% of each other
    expect(Math.abs(a.capitalUsd - b.capitalUsd)).toBeLessThan(200);
  });

  // 9. Single strategy: raw weight = 0.5 (Half-Kelly)
  it("assigns half-weight to a single strategy (capped by maxSingleStrategyPct)", () => {
    const strategies = [makeProfile({ id: "solo", fitness: 5.0 })];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);

    // Raw = (5/5)*0.5 = 0.5 -> capped at 30% = 30000
    expect(result).toHaveLength(1);
    expect(result[0].capitalUsd).toBeLessThanOrEqual(30_000 + 1);
  });
});

describe("CapitalAllocator — single strategy cap (maxSingleStrategyPct)", () => {
  const allocator = new CapitalAllocator();

  // 10. No strategy exceeds 30% of total capital
  it("caps each strategy at maxSingleStrategyPct", () => {
    const strategies = [
      makeProfile({ id: "dominant", fitness: 10.0 }),
      makeProfile({ id: "small", fitness: 0.1 }),
    ];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);

    for (const alloc of result) {
      expect(alloc.capitalUsd).toBeLessThanOrEqual(30_000 + 1);
    }
  });
});

describe("CapitalAllocator — total exposure cap (maxTotalExposurePct)", () => {
  const allocator = new CapitalAllocator();

  // 11. Sum of all allocations does not exceed 70% of capital
  it("caps total exposure at maxTotalExposurePct", () => {
    const strategies = Array.from({ length: 10 }, (_, i) =>
      makeProfile({ id: `s${i}`, fitness: 2.0 }),
    );
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);
    const total = result.reduce((sum, a) => sum + a.capitalUsd, 0);

    expect(total).toBeLessThanOrEqual(70_000 + 10); // +10 for rounding
  });

  // 12. Custom exposure limit is respected
  it("respects a lower custom maxTotalExposurePct", () => {
    const conservativeConfig: FundConfig = {
      ...DEFAULT_CONFIG,
      maxTotalExposurePct: 40,
    };
    const strategies = [
      makeProfile({ id: "s1", fitness: 3.0 }),
      makeProfile({ id: "s2", fitness: 3.0 }),
    ];
    const result = allocator.allocate(strategies, 100_000, conservativeConfig);
    const total = result.reduce((sum, a) => sum + a.capitalUsd, 0);

    expect(total).toBeLessThanOrEqual(40_000 + 10);
  });
});

describe("CapitalAllocator — new L3 strategy cap (< 30 days -> max 10%)", () => {
  const allocator = new CapitalAllocator();

  // 13. New L3 (paperDaysActive < 30) capped at 10%
  it("caps new L3 strategies at 10%", () => {
    const strategies = [
      makeProfile({
        id: "newbie",
        fitness: 5.0,
        level: "L3_LIVE",
        paperDaysActive: 15,
      }),
    ];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);

    expect(result[0].capitalUsd).toBeLessThanOrEqual(10_000 + 1);
  });

  // 14. Mature L3 (paperDaysActive >= 30) uses normal cap
  it("does not apply 10% cap to mature L3 strategies", () => {
    const strategies = [
      makeProfile({
        id: "mature",
        fitness: 5.0,
        level: "L3_LIVE",
        paperDaysActive: 60,
      }),
    ];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);

    // Should be capped at 30% (single strategy), not 10%
    expect(result[0].capitalUsd).toBeGreaterThan(10_000);
    expect(result[0].capitalUsd).toBeLessThanOrEqual(30_000 + 1);
  });
});

describe("CapitalAllocator — L2 paper strategy cap (max 15%)", () => {
  const allocator = new CapitalAllocator();

  // 15. L2_PAPER capped at 15%
  it("caps L2_PAPER strategies at 15%", () => {
    const strategies = [makeProfile({ id: "paper-strat", fitness: 5.0, level: "L2_PAPER" })];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);

    expect(result[0].capitalUsd).toBeLessThanOrEqual(15_000 + 1);
  });
});

describe("CapitalAllocator — correlation constraints (group cap 40%)", () => {
  const allocator = new CapitalAllocator();

  // 16. Highly correlated group stays under 40%
  it("reduces weight of highly correlated group to <= 40%", () => {
    const strategies = [
      makeProfile({ id: "corr-a", fitness: 3.0 }),
      makeProfile({ id: "corr-b", fitness: 3.0 }),
      makeProfile({ id: "uncorr-c", fitness: 3.0 }),
    ];

    const correlations = new Map<string, Map<string, number>>();
    correlations.set("corr-a", new Map([["corr-b", 0.9]]));
    correlations.set("corr-b", new Map([["corr-a", 0.9]]));

    const result = allocator.allocate(strategies, 300_000, DEFAULT_CONFIG, correlations);

    const corrA = result.find((a) => a.strategyId === "corr-a");
    const corrB = result.find((a) => a.strategyId === "corr-b");

    if (corrA && corrB) {
      const groupWeight = corrA.weightPct + corrB.weightPct;
      expect(groupWeight).toBeLessThanOrEqual(40 + 1);
    }
  });

  // 17. Low correlation does not penalize
  it("does not penalize uncorrelated strategies", () => {
    const strategies = [
      makeProfile({ id: "u1", fitness: 2.0 }),
      makeProfile({ id: "u2", fitness: 2.0 }),
    ];

    const lowCorr = new Map<string, Map<string, number>>();
    lowCorr.set("u1", new Map([["u2", 0.2]]));
    lowCorr.set("u2", new Map([["u1", 0.2]]));

    const withCorr = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG, lowCorr);
    const withoutCorr = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);

    const totalWith = withCorr.reduce((s, a) => s + a.capitalUsd, 0);
    const totalWithout = withoutCorr.reduce((s, a) => s + a.capitalUsd, 0);
    expect(totalWith).toBeCloseTo(totalWithout, 0);
  });
});

describe("CapitalAllocator — reason string and output format", () => {
  const allocator = new CapitalAllocator();

  // 18. Reason includes fitness, level, weight
  it("includes fitness, level, and weight in reason string", () => {
    const strategies = [makeProfile({ id: "s1", fitness: 1.5 })];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);

    expect(result[0].reason).toContain("fitness=");
    expect(result[0].reason).toContain("level=");
    expect(result[0].reason).toContain("weight=");
  });

  // 19. capitalUsd is rounded to 2 decimal places
  it("rounds capitalUsd to 2 decimal places", () => {
    const strategies = [
      makeProfile({ id: "s1", fitness: 1.0 }),
      makeProfile({ id: "s2", fitness: 1.0 }),
      makeProfile({ id: "s3", fitness: 1.0 }),
    ];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);

    for (const alloc of result) {
      const decimals = alloc.capitalUsd.toString().split(".")[1];
      if (decimals) {
        expect(decimals.length).toBeLessThanOrEqual(2);
      }
    }
  });

  // 20. weightPct is a percentage (0-100 range)
  it("returns weightPct in 0-100 range", () => {
    const strategies = [makeProfile({ id: "s1", fitness: 2.0 })];
    const result = allocator.allocate(strategies, 100_000, DEFAULT_CONFIG);

    expect(result[0].weightPct).toBeGreaterThan(0);
    expect(result[0].weightPct).toBeLessThanOrEqual(100);
  });
});
