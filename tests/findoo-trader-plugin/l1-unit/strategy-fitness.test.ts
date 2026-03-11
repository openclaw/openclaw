/**
 * L1 Unit Tests — Strategy Fitness & Statistical Functions
 *
 * Covers two modules:
 * 1. shared/stats.ts + strategy/stats.ts: sharpeRatio, sortinoRatio,
 *    maxDrawdown, winRate, profitFactor, calmarRatio
 * 2. strategy/fitness.ts: calculateFitness composite scoring with penalties
 *
 * All expected results are verified by hand calculation.
 */

import { describe, it, expect } from "vitest";
import { sharpeRatio } from "../../../extensions/findoo-trader-plugin/src/shared/stats.js";
import type { FitnessInput } from "../../../extensions/findoo-trader-plugin/src/shared/types.js";
import { calculateFitness } from "../../../extensions/findoo-trader-plugin/src/strategy/fitness.js";
import {
  sortinoRatio,
  maxDrawdown,
  winRate,
  profitFactor,
  calmarRatio,
} from "../../../extensions/findoo-trader-plugin/src/strategy/stats.js";

// =============================================================================
// sharpeRatio
// =============================================================================

describe("sharpeRatio", () => {
  it("computes annualized Sharpe for known daily returns", () => {
    const returns = [0.01, -0.005, 0.008, -0.002, 0.004];
    const m = returns.reduce((s, v) => s + v, 0) / returns.length;
    const variance = returns.reduce((s, v) => s + (v - m) ** 2, 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);
    const expected = (m / sd) * Math.sqrt(252);

    expect(sharpeRatio(returns)).toBeCloseTo(expected, 6);
  });

  it("returns positive Sharpe for all positive returns", () => {
    expect(sharpeRatio([0.01, 0.02, 0.015, 0.01, 0.02])).toBeGreaterThan(0);
  });

  it("returns negative Sharpe for all negative returns", () => {
    expect(sharpeRatio([-0.01, -0.02, -0.015, -0.01, -0.02])).toBeLessThan(0);
  });

  it("returns Infinity for zero-variance positive returns", () => {
    expect(sharpeRatio([0.01, 0.01, 0.01, 0.01])).toBe(Infinity);
  });

  it("returns NaN for all-zero returns", () => {
    expect(sharpeRatio([0, 0, 0, 0])).toBeNaN();
  });
});

// =============================================================================
// sortinoRatio
// =============================================================================

describe("sortinoRatio", () => {
  it("returns Infinity when all returns are positive (no downside)", () => {
    expect(sortinoRatio([0.01, 0.02, 0.005, 0.015])).toBe(Infinity);
  });

  it("computes Sortino for mixed returns using downside deviation", () => {
    const returns = [0.02, -0.01, 0.03, -0.02, 0.01];
    const m = returns.reduce((s, v) => s + v, 0) / returns.length;
    const downsideSquares = returns.filter((r) => r < 0).map((r) => r * r);
    const downsideDev = Math.sqrt(downsideSquares.reduce((s, v) => s + v, 0) / returns.length);
    const expected = (m / downsideDev) * Math.sqrt(252);

    expect(sortinoRatio(returns)).toBeCloseTo(expected, 4);
  });

  it("returns negative Sortino for all negative returns", () => {
    expect(sortinoRatio([-0.01, -0.02, -0.015])).toBeLessThan(0);
  });
});

// =============================================================================
// maxDrawdown
// =============================================================================

describe("maxDrawdown", () => {
  it("identifies the worst peak-to-trough decline", () => {
    const equity = [100, 120, 90, 110];
    const result = maxDrawdown(equity);
    expect(result.maxDD).toBeCloseTo(-25, 2);
    expect(result.peak).toBe(120);
    expect(result.trough).toBe(90);
  });

  it("returns 0 for monotonically increasing equity", () => {
    expect(maxDrawdown([100, 105, 110, 115, 120]).maxDD).toBe(0);
  });

  it("returns 0 for single-element equity curve", () => {
    expect(maxDrawdown([100]).maxDD).toBe(0);
  });

  it("returns 0 for empty equity curve", () => {
    expect(maxDrawdown([]).maxDD).toBe(0);
  });

  it("picks the worst drawdown from multiple dips", () => {
    const equity = [100, 95, 105, 80, 100];
    const result = maxDrawdown(equity);
    expect(result.maxDD).toBeCloseTo(-23.81, 1);
    expect(result.peak).toBe(105);
    expect(result.trough).toBe(80);
  });
});

// =============================================================================
// winRate
// =============================================================================

describe("winRate", () => {
  it("computes correct win rate percentage", () => {
    const trades = [{ pnl: 100 }, { pnl: -50 }, { pnl: 200 }, { pnl: -30 }, { pnl: 150 }];
    expect(winRate(trades)).toBeCloseTo(60, 2);
  });

  it("returns NaN for empty trades array", () => {
    expect(winRate([])).toBeNaN();
  });

  it("returns 100 when all trades are winners", () => {
    expect(winRate([{ pnl: 10 }, { pnl: 20 }, { pnl: 5 }])).toBe(100);
  });

  it("returns 0 when all trades are losers", () => {
    expect(winRate([{ pnl: -10 }, { pnl: -20 }, { pnl: -5 }])).toBe(0);
  });

  it("does not count zero-pnl trades as wins", () => {
    expect(winRate([{ pnl: 0 }, { pnl: 0 }, { pnl: 10 }])).toBeCloseTo(33.33, 1);
  });
});

// =============================================================================
// profitFactor
// =============================================================================

describe("profitFactor", () => {
  it("computes ratio of total wins to total losses", () => {
    expect(profitFactor([100, 200, 150], [-50, -100])).toBeCloseTo(3.0, 4);
  });

  it("returns Infinity when there are no losses", () => {
    expect(profitFactor([100, 200], [])).toBe(Infinity);
  });

  it("returns 0 when there are no wins", () => {
    expect(profitFactor([], [-50, -100])).toBe(0);
  });

  it("returns 0 when both wins and losses are empty", () => {
    expect(profitFactor([], [])).toBe(0);
  });

  it("returns 1.0 when wins equal losses", () => {
    expect(profitFactor([100], [-100])).toBeCloseTo(1.0, 4);
  });
});

// =============================================================================
// calmarRatio
// =============================================================================

describe("calmarRatio", () => {
  it("computes annualized return / |maxDD|", () => {
    expect(calmarRatio(20, -10)).toBeCloseTo(2.0, 4);
  });

  it("returns Infinity when max drawdown is zero", () => {
    expect(calmarRatio(10, 0)).toBe(Infinity);
  });
});

// =============================================================================
// calculateFitness — composite scoring
// =============================================================================

/** Helper matching the internal windowScore formula. */
function windowScore(w: { sharpe: number; maxDD: number; trades: number }): number {
  return w.sharpe - Math.abs(w.maxDD);
}

describe("Fitness — base score with paper data (50/35/15 weights)", () => {
  it("weights paper*50% + recent*35% + longTerm*15%", () => {
    const input: FitnessInput = {
      longTerm: { sharpe: 1.0, maxDD: -0.1, trades: 100 },
      recent: { sharpe: 1.2, maxDD: -0.08, trades: 50 },
      paper: { sharpe: 1.1, maxDD: -0.05, trades: 30 },
    };

    const expectedBase =
      windowScore(input.paper!) * 0.5 +
      windowScore(input.recent) * 0.35 +
      windowScore(input.longTerm) * 0.15;
    const expectedOverfit = Math.max(0, input.recent.sharpe - input.paper!.sharpe) * 0.5;

    expect(calculateFitness(input)).toBeCloseTo(expectedBase - expectedOverfit, 6);
  });
});

describe("Fitness — base score without paper data (70/30 weights)", () => {
  it("weights recent*70% + longTerm*30%", () => {
    const input: FitnessInput = {
      longTerm: { sharpe: 0.8, maxDD: -0.15, trades: 80 },
      recent: { sharpe: 0.9, maxDD: -0.1, trades: 40 },
    };

    const expected = windowScore(input.recent) * 0.7 + windowScore(input.longTerm) * 0.3;
    expect(calculateFitness(input)).toBeCloseTo(expected, 6);
  });
});

describe("Fitness — penalties", () => {
  it("penalizes decay when longTerm sharpe > recent sharpe", () => {
    // Both inputs have the same base score contribution from longTerm
    // but the first has longTerm.sharpe > recent.sharpe, triggering decay
    const degrading: FitnessInput = {
      longTerm: { sharpe: 1.5, maxDD: -0.1, trades: 100 },
      recent: { sharpe: 0.5, maxDD: -0.1, trades: 50 },
    };
    // improving: recent >= longTerm -> no decay penalty, same base
    const _improving: FitnessInput = {
      longTerm: { sharpe: 0.5, maxDD: -0.1, trades: 100 },
      recent: { sharpe: 1.5, maxDD: -0.1, trades: 50 },
    };
    // The improving one has same total sharpe sum but no decay penalty
    // Both have the same window scores (just swapped), verify decay effect
    const decayPenalty = Math.max(0, 1.5 - 0.5) * 0.3; // 0.3
    expect(decayPenalty).toBeGreaterThan(0);
    // Directly verify: degrading has lower fitness than if decay penalty were removed
    const degradingResult = calculateFitness(degrading);
    // Calculate what it would be without decay penalty
    const ltScore = 1.5 - 0.1; // 1.4
    const recentScore = 0.5 - 0.1; // 0.4
    const baseWithoutPenalty = recentScore * 0.7 + ltScore * 0.3; // 0.28 + 0.42 = 0.70
    expect(degradingResult).toBeCloseTo(baseWithoutPenalty - decayPenalty, 6);
  });

  it("reduces score proportional to portfolio correlation", () => {
    const base: FitnessInput = {
      longTerm: { sharpe: 1.0, maxDD: -0.1, trades: 100 },
      recent: { sharpe: 1.0, maxDD: -0.1, trades: 50 },
    };
    const uncorr = calculateFitness({ ...base, correlationWithPortfolio: 0 });
    const corr = calculateFitness({ ...base, correlationWithPortfolio: 0.8 });
    expect(uncorr - corr).toBeCloseTo(0.16, 6);
  });

  it("penalizes strategies older than 180 days", () => {
    const base: FitnessInput = {
      longTerm: { sharpe: 1.0, maxDD: -0.1, trades: 100 },
      recent: { sharpe: 1.0, maxDD: -0.1, trades: 50 },
    };
    const young = calculateFitness({ ...base, daysSinceLaunch: 100 });
    const old = calculateFitness({ ...base, daysSinceLaunch: 365 });
    expect(young - old).toBeCloseTo((0.1 * (365 - 180)) / 365, 4);
  });

  it("applies all four penalties simultaneously", () => {
    const input: FitnessInput = {
      longTerm: { sharpe: 2.0, maxDD: -0.1, trades: 100 },
      recent: { sharpe: 1.0, maxDD: -0.1, trades: 50 },
      paper: { sharpe: 0.5, maxDD: -0.1, trades: 30 },
      correlationWithPortfolio: 0.6,
      daysSinceLaunch: 365,
    };

    const base =
      windowScore(input.paper!) * 0.5 +
      windowScore(input.recent) * 0.35 +
      windowScore(input.longTerm) * 0.15;
    const decay = Math.max(0, 2.0 - 1.0) * 0.3;
    const overfit = Math.max(0, 1.0 - 0.5) * 0.5;
    const corr = 0.6 * 0.2;
    const halfLife = (0.1 * (365 - 180)) / 365;

    expect(calculateFitness(input)).toBeCloseTo(base - decay - overfit - corr - halfLife, 4);
  });
});

describe("Fitness — edge cases", () => {
  it("handles all-zero sharpe/maxDD gracefully", () => {
    const input: FitnessInput = {
      longTerm: { sharpe: 0, maxDD: 0, trades: 0 },
      recent: { sharpe: 0, maxDD: 0, trades: 0 },
    };
    expect(calculateFitness(input)).toBe(0);
  });

  it("handles negative sharpe values", () => {
    const input: FitnessInput = {
      longTerm: { sharpe: -0.5, maxDD: -0.3, trades: 50 },
      recent: { sharpe: -0.3, maxDD: -0.2, trades: 30 },
    };
    expect(calculateFitness(input)).toBeLessThan(0);
  });

  it("produces higher fitness for genuinely better strategies", () => {
    const good: FitnessInput = {
      longTerm: { sharpe: 2.0, maxDD: -0.05, trades: 200 },
      recent: { sharpe: 2.2, maxDD: -0.03, trades: 100 },
      paper: { sharpe: 2.1, maxDD: -0.04, trades: 50 },
    };
    const bad: FitnessInput = {
      longTerm: { sharpe: 0.3, maxDD: -0.3, trades: 50 },
      recent: { sharpe: 0.2, maxDD: -0.25, trades: 20 },
      paper: { sharpe: 0.1, maxDD: -0.2, trades: 10 },
    };
    expect(calculateFitness(good)).toBeGreaterThan(calculateFitness(bad));
  });
});
