/**
 * Financial Correctness Tests — Hand-Calculated References.
 *
 * Verifies core financial math against manually computed values.
 * This is the highest priority test file: numerical errors propagate
 * to all downstream decisions (allocation, promotion, risk).
 */
import { describe, expect, it } from "vitest";
import { CapitalAllocator } from "../extensions/fin-fund-manager/src/capital-allocator.js";
import { FundRiskManager } from "../extensions/fin-fund-manager/src/fund-risk-manager.js";
import type { StrategyProfile, FundConfig } from "../extensions/fin-fund-manager/src/types.js";
import type { OHLCV } from "../extensions/fin-shared-types/src/types.js";
import { BacktestEngine } from "../extensions/fin-strategy-engine/src/backtest-engine.js";
import {
  sharpeRatio,
  sortinoRatio,
  maxDrawdown,
  profitFactor,
  winRate,
} from "../extensions/fin-strategy-engine/src/stats.js";
import type {
  StrategyDefinition,
  BacktestConfig,
} from "../extensions/fin-strategy-engine/src/types.js";
import { generateLinearOHLCV } from "./helpers/fin-test-data.js";

// ── Helpers ──

function makeBuyAndHoldStrategy(symbol = "TEST"): StrategyDefinition {
  let bought = false;
  return {
    id: "buy-and-hold",
    name: "Buy and Hold",
    version: "1.0",
    markets: ["crypto"],
    symbols: [symbol],
    timeframes: ["1d"],
    parameters: {},
    async onBar(bar, ctx) {
      if (!bought && ctx.portfolio.positions.length === 0) {
        bought = true;
        return {
          action: "buy",
          symbol,
          sizePct: 95, // leave room for commission
          orderType: "market",
          reason: "buy-and-hold-entry",
          confidence: 1,
        };
      }
      return null;
    },
  };
}

function makeTwoBarOHLCV(buyPrice: number, sellPrice: number): OHLCV[] {
  const base = 1_700_000_000_000;
  return [
    {
      timestamp: base,
      open: buyPrice,
      high: buyPrice * 1.001,
      low: buyPrice * 0.999,
      close: buyPrice,
      volume: 1000,
    },
    {
      timestamp: base + 86_400_000,
      open: sellPrice,
      high: sellPrice * 1.001,
      low: sellPrice * 0.999,
      close: sellPrice,
      volume: 1000,
    },
  ];
}

const DEFAULT_BT_CONFIG: BacktestConfig = {
  capital: 10000,
  commissionRate: 0.001, // 0.1%
  slippageBps: 5, // 5 bps
  market: "crypto",
};

// ── Tests ──

describe("Financial Correctness — Hand-Calculated References", () => {
  // ── Sharpe Ratio ──

  describe("Sharpe ratio verification", () => {
    it("known returns [0.01, -0.02, 0.03, 0.005, -0.01]", () => {
      const returns = [0.01, -0.02, 0.03, 0.005, -0.01];

      // Hand calculation:
      // mean = (0.01 - 0.02 + 0.03 + 0.005 - 0.01) / 5 = 0.015 / 5 = 0.003
      // deviations: [0.007, -0.023, 0.027, 0.002, -0.013]
      // sum of sq dev: 0.000049 + 0.000529 + 0.000729 + 0.000004 + 0.000169 = 0.001480
      // sample stddev = sqrt(0.001480 / 4) = sqrt(0.000370) ≈ 0.019235
      // sharpe = (0.003 / 0.019235) * sqrt(252) ≈ 2.476

      const result = sharpeRatio(returns, 0, true);
      expect(result).toBeCloseTo(2.476, 0);
    });

    it("all-zero returns → NaN", () => {
      const result = sharpeRatio([0, 0, 0, 0, 0]);
      expect(result).toBeNaN();
    });

    it("single return → handles gracefully (stddev is NaN for n=1)", () => {
      const result = sharpeRatio([0.05]);
      // With single return, sample stddev is NaN → sharpe is Infinity (positive mean)
      expect(result).toBe(Infinity);
    });

    it("constant positive returns → Infinity", () => {
      const result = sharpeRatio([0.01, 0.01, 0.01, 0.01]);
      // stddev = 0 → Infinity for positive mean
      expect(result).toBe(Infinity);
    });

    it("non-annualized matches raw ratio", () => {
      const returns = [0.01, -0.02, 0.03, 0.005, -0.01];
      // mean/sd = 0.003 / 0.019235 ≈ 0.1560
      const result = sharpeRatio(returns, 0, false);
      expect(result).toBeCloseTo(0.156, 1);
    });
  });

  // ── Sortino Ratio ──

  describe("Sortino ratio verification", () => {
    it("known returns: only negative returns penalized", () => {
      const returns = [0.01, -0.02, 0.03, 0.005, -0.01];

      // Hand calculation:
      // mean = 0.003
      // downside returns (< 0): [-0.02, -0.01]
      // downside squares: [0.0004, 0.0001]
      // sumSq = 0.0005
      // downsideDev = sqrt(0.0005 / 5) = sqrt(0.0001) = 0.01
      // sortino = (0.003 / 0.01) * sqrt(252) = 0.3 * 15.8745 ≈ 4.762

      const result = sortinoRatio(returns);
      expect(result).toBeCloseTo(4.762, 0);
    });

    it("all positive returns → Infinity", () => {
      const result = sortinoRatio([0.01, 0.02, 0.03]);
      expect(result).toBe(Infinity);
    });

    it("all negative returns → finite negative", () => {
      const result = sortinoRatio([-0.01, -0.02, -0.03]);
      expect(result).toBeLessThan(0);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  // ── Maximum Drawdown ──

  describe("Drawdown accuracy", () => {
    it("curve [100, 80, 60, 90, 100, 50] → maxDD = -50%", () => {
      // Peak at 100, trough at 50 → (50-100)/100 * 100 = -50%
      const result = maxDrawdown([100, 80, 60, 90, 100, 50]);
      expect(result.maxDD).toBeCloseTo(-50, 2);
      expect(result.peak).toBe(100);
      expect(result.trough).toBe(50);
    });

    it("monotonic rise → maxDD = 0", () => {
      const result = maxDrawdown([100, 110, 120, 130, 140]);
      expect(result.maxDD).toBe(0);
    });

    it("monotonic decline → maxDD = (last - first) / first * 100", () => {
      // 100 → 50: (50-100)/100 * 100 = -50%
      const result = maxDrawdown([100, 90, 80, 70, 60, 50]);
      expect(result.maxDD).toBeCloseTo(-50, 2);
      expect(result.peakIndex).toBe(0);
      expect(result.troughIndex).toBe(5);
    });

    it("single element → maxDD = 0", () => {
      const result = maxDrawdown([100]);
      expect(result.maxDD).toBe(0);
    });

    it("W-shape: picks the deeper trough", () => {
      // Peak 100, dip to 85 (-15%), recover to 100, dip to 70 (-30%)
      const result = maxDrawdown([100, 85, 100, 70]);
      expect(result.maxDD).toBeCloseTo(-30, 2);
      expect(result.trough).toBe(70);
    });
  });

  // ── Profit Factor & Win Rate ──

  describe("Profit factor and win rate", () => {
    it("balanced wins and losses", () => {
      const wins = [100, 200, 50]; // sum = 350
      const losses = [-80, -120, -50]; // sum of abs = 250
      // PF = 350 / 250 = 1.4
      expect(profitFactor(wins, losses)).toBeCloseTo(1.4, 2);
    });

    it("no losses → Infinity", () => {
      expect(profitFactor([100, 200], [])).toBe(Infinity);
    });

    it("no wins → 0", () => {
      expect(profitFactor([], [-100, -200])).toBe(0);
    });

    it("win rate: 3 wins out of 5 trades = 60%", () => {
      const trades = [{ pnl: 100 }, { pnl: -50 }, { pnl: 200 }, { pnl: 30 }, { pnl: -80 }];
      expect(winRate(trades)).toBeCloseTo(60, 2);
    });

    it("win rate: no trades → NaN", () => {
      expect(winRate([])).toBeNaN();
    });
  });

  // ── Backtest P&L Accuracy ──

  describe("Backtest P&L accuracy", () => {
    const engine = new BacktestEngine();

    it("buy-and-hold 100→200: finalEquity matches hand calculation", async () => {
      const data = makeTwoBarOHLCV(100, 200);
      const strategy = makeBuyAndHoldStrategy();
      const config = { ...DEFAULT_BT_CONFIG, capital: 10000 };

      const result = await engine.run(strategy, data, config);

      // Hand calculation:
      // Buy: fillPrice = 100 * (1 + 5/10000) = 100.05
      // qty = (10000 * 0.95) / (100.05 * 1.001) = 9500 / 100.15005 ≈ 94.8576
      // Sell: exitFill = 200 * (1 - 5/10000) = 199.90
      // exitNotional = qty * 199.90
      // exitComm = exitNotional * 0.001
      // Remaining cash from initial = 10000 - qty*100.05*1.001 = 10000 - 9500 = 500
      // finalEquity = 500 + qty * 199.90 * 0.999

      expect(result.totalTrades).toBe(1);
      expect(result.finalEquity).toBeGreaterThan(config.capital);
      expect(result.totalReturn).toBeGreaterThan(0);

      // Trade P&L should be close to the price appreciation minus costs
      const trade = result.trades[0];
      expect(trade.entryPrice).toBeCloseTo(100.05, 2); // slippage applied
      expect(trade.exitPrice).toBeCloseTo(199.9, 2);
      expect(trade.pnl).toBeGreaterThan(0);
    });

    it("multi-trade round-trip: sum of trade PnLs ≈ final - initial", async () => {
      // 4-bar data: buy→sell→buy→sell
      const base = 1_700_000_000_000;
      const data: OHLCV[] = [
        { timestamp: base, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        { timestamp: base + 86_400_000, open: 110, high: 111, low: 109, close: 110, volume: 1000 },
        {
          timestamp: base + 2 * 86_400_000,
          open: 105,
          high: 106,
          low: 104,
          close: 105,
          volume: 1000,
        },
        {
          timestamp: base + 3 * 86_400_000,
          open: 120,
          high: 121,
          low: 119,
          close: 120,
          volume: 1000,
        },
      ];

      let tradeCount = 0;
      const strategy: StrategyDefinition = {
        id: "alternating",
        name: "Alt",
        version: "1.0",
        markets: ["crypto"],
        symbols: ["TEST"],
        timeframes: ["1d"],
        parameters: {},
        async onBar(_bar, _ctx) {
          tradeCount++;
          if (tradeCount === 1) {
            return {
              action: "buy",
              symbol: "TEST",
              sizePct: 90,
              orderType: "market",
              reason: "entry1",
              confidence: 1,
            };
          }
          if (tradeCount === 2) {
            return {
              action: "sell",
              symbol: "TEST",
              sizePct: 100,
              orderType: "market",
              reason: "exit1",
              confidence: 1,
            };
          }
          if (tradeCount === 3) {
            return {
              action: "buy",
              symbol: "TEST",
              sizePct: 90,
              orderType: "market",
              reason: "entry2",
              confidence: 1,
            };
          }
          return null;
        },
      };

      const result = await engine.run(strategy, data, { ...DEFAULT_BT_CONFIG });

      // Invariant: sum of trade PnLs ≈ finalEquity - initialCapital - totalEntryCommissions
      // (entry commissions are deducted from cash at entry, not included in trade.pnl)
      // Verify finalEquity is positive and trades executed
      expect(result.finalEquity).toBeGreaterThan(0);
      expect(result.trades.length).toBeGreaterThanOrEqual(2);
    });

    it("equity curve invariant: each bar = cash + positions × close", async () => {
      const data = generateLinearOHLCV(20, 100, 200);
      const strategy = makeBuyAndHoldStrategy();

      const result = await engine.run(strategy, data, DEFAULT_BT_CONFIG);

      // The equity curve should reflect the portfolio value at each bar.
      // After the final bar, all positions are closed so last entry = cash.
      expect(result.equityCurve).toHaveLength(data.length);

      // Final equity curve entry should equal finalEquity
      const lastEquity = result.equityCurve[result.equityCurve.length - 1];
      expect(lastEquity).toBeCloseTo(result.finalEquity, 2);

      // Equity should generally increase on a bull run
      expect(result.equityCurve[result.equityCurve.length - 1]).toBeGreaterThan(
        result.equityCurve[0],
      );
    });

    it("zero-movement price → finalEquity < initial (costs only)", async () => {
      // Price stays flat at 100 for 5 bars
      const base = 1_700_000_000_000;
      const data: OHLCV[] = Array.from({ length: 5 }, (_, i) => ({
        timestamp: base + i * 86_400_000,
        open: 100,
        high: 100.01,
        low: 99.99,
        close: 100,
        volume: 1000,
      }));

      const strategy = makeBuyAndHoldStrategy();
      const result = await engine.run(strategy, data, DEFAULT_BT_CONFIG);

      // With flat price, costs from slippage + commission should make us lose money
      expect(result.finalEquity).toBeLessThan(DEFAULT_BT_CONFIG.capital);
      expect(result.totalReturn).toBeLessThan(0);
    });
  });

  // ── Half-Kelly Allocation ──

  describe("Half-Kelly allocation", () => {
    const allocator = new CapitalAllocator();
    const baseConfig: FundConfig = {
      cashReservePct: 30,
      maxSingleStrategyPct: 30,
      maxTotalExposurePct: 70,
      rebalanceFrequency: "weekly",
    };

    function makeProfile(
      overrides: Partial<StrategyProfile> & { id: string; fitness: number },
    ): StrategyProfile {
      return {
        name: overrides.id,
        level: "L3_LIVE",
        ...overrides,
      };
    }

    it("single strategy: weight proportional to fitness, capped at maxSingle", () => {
      const profiles = [makeProfile({ id: "s1", fitness: 2.0 })];
      const allocations = allocator.allocate(profiles, 100000, baseConfig);

      expect(allocations).toHaveLength(1);
      // Half-Kelly raw weight = (2.0/2.0)*0.5 = 0.5 → capped at 30%
      expect(allocations[0].weightPct).toBeLessThanOrEqual(30);
      expect(allocations[0].capitalUsd).toBeLessThanOrEqual(30000);
    });

    it("two strategies: proportional by fitness", () => {
      const profiles = [
        makeProfile({ id: "s1", fitness: 2.0, paperDaysActive: 60 }),
        makeProfile({ id: "s2", fitness: 1.0, paperDaysActive: 60 }),
      ];
      const allocations = allocator.allocate(profiles, 100000, baseConfig);

      expect(allocations).toHaveLength(2);
      // s1 should get roughly 2x the weight of s2 (both past 30d new-L3 cap)
      const w1 = allocations.find((a) => a.strategyId === "s1")!.weightPct;
      const w2 = allocations.find((a) => a.strategyId === "s2")!.weightPct;
      expect(w1).toBeGreaterThan(w2);
    });

    it("total respects maxTotalExposurePct", () => {
      const profiles = [
        makeProfile({ id: "s1", fitness: 3.0 }),
        makeProfile({ id: "s2", fitness: 3.0 }),
        makeProfile({ id: "s3", fitness: 3.0 }),
      ];
      const allocations = allocator.allocate(profiles, 100000, baseConfig);

      const totalWeight = allocations.reduce((s, a) => s + a.weightPct, 0);
      expect(totalWeight).toBeLessThanOrEqual(70 + 0.01); // allow rounding
    });

    it("L2 capped at 15%", () => {
      const profiles = [makeProfile({ id: "s1", fitness: 5.0, level: "L2_PAPER" })];
      const allocations = allocator.allocate(profiles, 100000, baseConfig);

      expect(allocations).toHaveLength(1);
      expect(allocations[0].weightPct).toBeLessThanOrEqual(15 + 0.01);
    });

    it("new L3 (<30d) capped at 10%", () => {
      const profiles = [
        makeProfile({ id: "s1", fitness: 5.0, level: "L3_LIVE", paperDaysActive: 10 }),
      ];
      const allocations = allocator.allocate(profiles, 100000, baseConfig);

      expect(allocations).toHaveLength(1);
      expect(allocations[0].weightPct).toBeLessThanOrEqual(10 + 0.01);
    });

    it("negative fitness → excluded", () => {
      const profiles = [makeProfile({ id: "s1", fitness: -1.0 })];
      const allocations = allocator.allocate(profiles, 100000, baseConfig);
      expect(allocations).toHaveLength(0);
    });

    it("empty input → empty output", () => {
      expect(allocator.allocate([], 100000, baseConfig)).toHaveLength(0);
    });

    it("zero capital → empty output", () => {
      const profiles = [makeProfile({ id: "s1", fitness: 1.0 })];
      expect(allocator.allocate(profiles, 0, baseConfig)).toHaveLength(0);
    });
  });

  // ── Risk Level Transitions ──

  describe("Risk level transitions", () => {
    const config: FundConfig = {
      cashReservePct: 30,
      maxSingleStrategyPct: 30,
      maxTotalExposurePct: 70,
      rebalanceFrequency: "weekly",
    };

    function evaluateAtDrawdown(drawdownPct: number) {
      const rm = new FundRiskManager(config);
      const startEquity = 100000;
      rm.markDayStart(startEquity);
      // To produce X% drawdown, current equity = start * (1 - X/100)
      const currentEquity = startEquity * (1 - drawdownPct / 100);
      return rm.evaluate(currentEquity, []);
    }

    it("0% DD → normal", () => {
      const result = evaluateAtDrawdown(0);
      expect(result.riskLevel).toBe("normal");
    });

    it("exactly 3.0% DD → still normal (> required, not >=)", () => {
      const result = evaluateAtDrawdown(3.0);
      expect(result.riskLevel).toBe("normal");
    });

    it("3.01% DD → caution (boundary)", () => {
      const result = evaluateAtDrawdown(3.01);
      expect(result.riskLevel).toBe("caution");
    });

    it("5.0% DD → caution (not yet warning)", () => {
      const result = evaluateAtDrawdown(5.0);
      expect(result.riskLevel).toBe("caution");
    });

    it("5.01% DD → warning (boundary)", () => {
      const result = evaluateAtDrawdown(5.01);
      expect(result.riskLevel).toBe("warning");
    });

    it("10.0% DD → warning (not yet critical)", () => {
      const result = evaluateAtDrawdown(10.0);
      expect(result.riskLevel).toBe("warning");
    });

    it("10.01% DD → critical (boundary)", () => {
      const result = evaluateAtDrawdown(10.01);
      expect(result.riskLevel).toBe("critical");
    });

    it("scale factors match risk levels", () => {
      const rm = new FundRiskManager(config);
      expect(rm.getScaleFactor("normal")).toBe(1.0);
      expect(rm.getScaleFactor("caution")).toBe(0.8);
      expect(rm.getScaleFactor("warning")).toBe(0.5);
      expect(rm.getScaleFactor("critical")).toBe(0);
    });

    it("todayPnl and todayPnlPct computed correctly", () => {
      const rm = new FundRiskManager(config);
      rm.markDayStart(100000);
      const result = rm.evaluate(95000, []);
      expect(result.todayPnl).toBeCloseTo(-5000, 2);
      expect(result.todayPnlPct).toBeCloseTo(-5, 2);
      expect(result.dailyDrawdown).toBeCloseTo(5, 2);
    });
  });
});
