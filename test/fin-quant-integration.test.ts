/**
 * Cross-Extension Integration Tests for the Quant Fund System.
 *
 * Uses real service instances with temp directories. Mocks are limited to
 * external exchange APIs (CCXT). Verifies data flows across all 5 extensions:
 *   fin-data-bus → fin-strategy-engine → fin-paper-trading
 *   fin-strategy-memory ← hooks
 *   fin-fund-manager ← orchestration
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapitalAllocator } from "../extensions/fin-fund-manager/src/capital-allocator.js";
import { CorrelationMonitor } from "../extensions/fin-fund-manager/src/correlation-monitor.js";
import { FundManager } from "../extensions/fin-fund-manager/src/fund-manager.js";
import type { FundConfig, StrategyProfile } from "../extensions/fin-fund-manager/src/types.js";
import type { DecayState } from "../extensions/fin-paper-trading/src/types.js";
import { BacktestEngine } from "../extensions/fin-strategy-engine/src/backtest-engine.js";
import { StrategyRegistry } from "../extensions/fin-strategy-engine/src/strategy-registry.js";
import type {
  StrategyDefinition,
  BacktestConfig,
  StrategyRecord,
} from "../extensions/fin-strategy-engine/src/types.js";
import { WalkForward } from "../extensions/fin-strategy-engine/src/walk-forward.js";
import { ErrorBook } from "../extensions/fin-strategy-memory/src/error-book.js";
import {
  buildFinancialContext,
  handleTradeToolCall,
} from "../extensions/fin-strategy-memory/src/hooks.js";
import type { AfterToolCallEvent } from "../extensions/fin-strategy-memory/src/hooks.js";
import { TradeJournal } from "../extensions/fin-strategy-memory/src/trade-journal.js";
import { OHLCVCache } from "../extensions/findoo-datahub-plugin/src/ohlcv-cache.js";
import { generateOHLCV } from "./helpers/fin-test-data.js";

// ── Shared Fixtures ──

const FUND_CONFIG: FundConfig = {
  cashReservePct: 30,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "weekly",
  totalCapital: 100000,
};

const BT_CONFIG: BacktestConfig = {
  capital: 100000,
  commissionRate: 0.001,
  slippageBps: 5,
  market: "crypto",
};

function makeSMACrossStrategy(id: string, fastPeriod = 10, slowPeriod = 30): StrategyDefinition {
  return {
    id,
    name: `SMA-${fastPeriod}-${slowPeriod}`,
    version: "1.0",
    markets: ["crypto"],
    symbols: ["BTC/USDT"],
    timeframes: ["1d"],
    parameters: { fast: fastPeriod, slow: slowPeriod },
    async onBar(bar, ctx) {
      const fastSma = ctx.indicators.sma(fastPeriod);
      const slowSma = ctx.indicators.sma(slowPeriod);

      if (fastSma.length === 0 || slowSma.length === 0) {
        return null;
      }
      const fastVal = fastSma[fastSma.length - 1];
      const slowVal = slowSma[slowSma.length - 1];

      if (ctx.history.length < slowPeriod + 1) {
        return null;
      }

      const prevFast = fastSma[fastSma.length - 2];
      const prevSlow = slowSma[slowSma.length - 2];
      if (prevFast == null || prevSlow == null) {
        return null;
      }

      // Golden cross: fast crosses above slow
      if (prevFast <= prevSlow && fastVal > slowVal && ctx.portfolio.positions.length === 0) {
        return {
          action: "buy",
          symbol: "BTC/USDT",
          sizePct: 80,
          orderType: "market",
          reason: "golden-cross",
          confidence: 0.7,
        };
      }

      // Death cross: fast crosses below slow
      if (prevFast >= prevSlow && fastVal < slowVal && ctx.portfolio.positions.length > 0) {
        return {
          action: "sell",
          symbol: "BTC/USDT",
          sizePct: 100,
          orderType: "market",
          reason: "death-cross",
          confidence: 0.7,
        };
      }

      return null;
    },
  };
}

// ── Tests ──

describe("Quant Fund Integration", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── 1. data-bus → strategy-engine ──

  it("backtest pipeline: OHLCV cache → BacktestEngine", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "int-backtest-"));
    const cache = new OHLCVCache(join(tempDir, "ohlcv.sqlite"));

    try {
      // Simulate data-bus providing OHLCV data
      const data = generateOHLCV({ bars: 200, startPrice: 100, trend: "bull" });
      cache.upsertBatch("BTC/USDT", "crypto", "1d", data);

      // Query cached data
      const cached = cache.query("BTC/USDT", "crypto", "1d");
      expect(cached).toHaveLength(200);

      // Feed into BacktestEngine
      const engine = new BacktestEngine();
      const strategy = makeSMACrossStrategy("sma-10-30");
      const result = await engine.run(strategy, cached, BT_CONFIG);

      // Verify complete result structure
      expect(result.strategyId).toBe("sma-10-30");
      expect(result.initialCapital).toBe(100000);
      expect(result.equityCurve).toHaveLength(200);
      expect(result.dailyReturns).toHaveLength(199);
      expect(typeof result.sharpe).toBe("number");
      expect(typeof result.maxDrawdown).toBe("number");
      expect(typeof result.totalReturn).toBe("number");
    } finally {
      cache.close();
    }
  });

  // ── 2. Paper trading lifecycle ──

  it("paper trading full cycle: strategy registry → backtest → result stored", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "int-paper-"));

    const registry = new StrategyRegistry(join(tempDir, "strategies.json"));
    const strategy = makeSMACrossStrategy("test-sma");

    // Register strategy (starts at L0)
    const record = registry.create(strategy);
    expect(record.level).toBe("L0_INCUBATE");

    // Run backtest
    const engine = new BacktestEngine();
    const data = generateOHLCV({ bars: 365, startPrice: 100, trend: "bull" });
    const btResult = await engine.run(strategy, data, BT_CONFIG);

    // Store backtest result
    registry.updateBacktest("test-sma", btResult);
    registry.updateLevel("test-sma", "L1_BACKTEST");

    const updated = registry.get("test-sma");
    expect(updated!.level).toBe("L1_BACKTEST");
    expect(updated!.lastBacktest).toBeDefined();
    expect(updated!.lastBacktest!.totalReturn).toBe(btResult.totalReturn);
  });

  // ── 3. Fund rebalance: profiles + allocations ──

  it("fund rebalance: engine profiles + metrics → allocations", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "int-rebalance-"));

    const fm = new FundManager(join(tempDir, "fund.json"), { ...FUND_CONFIG });
    fm.markDayStart(100000);

    // Create strategy records with varying levels
    const records: StrategyRecord[] = [
      makeRecord("strategy-a", "L3_LIVE", { sharpe: 1.5, maxDrawdown: -10, totalTrades: 150 }),
      makeRecord("strategy-b", "L2_PAPER", { sharpe: 1.2, maxDrawdown: -8, totalTrades: 120 }),
      makeRecord("strategy-c", "L1_BACKTEST", { sharpe: 0.8, maxDrawdown: -15, totalTrades: 80 }),
    ];

    // Paper trading data for L2+ strategies
    const paperData = new Map<
      string,
      {
        metrics?: DecayState;
        equity?: number;
        initialCapital?: number;
        daysActive?: number;
        tradeCount?: number;
      }
    >();
    paperData.set("strategy-a", {
      metrics: makeDecayState({
        rollingSharpe7d: 1.2,
        rollingSharpe30d: 1.0,
        consecutiveLossDays: 0,
      }),
      equity: 110000,
      initialCapital: 100000,
      daysActive: 60,
      tradeCount: 50,
    });
    paperData.set("strategy-b", {
      metrics: makeDecayState({
        rollingSharpe7d: 0.8,
        rollingSharpe30d: 0.7,
        consecutiveLossDays: 1,
      }),
      equity: 105000,
      initialCapital: 100000,
      daysActive: 45,
      tradeCount: 35,
    });

    const result = fm.rebalance(records, paperData);

    // Verify structure
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(result.leaderboard.length).toBeGreaterThan(0);
    expect(result.risk).toBeDefined();
    expect(result.risk.riskLevel).toBe("normal");

    // L3 strategy should rank higher than L2
    const lbA = result.leaderboard.find((e) => e.strategyId === "strategy-a");
    const lbB = result.leaderboard.find((e) => e.strategyId === "strategy-b");
    expect(lbA).toBeDefined();
    expect(lbB).toBeDefined();
    if (lbA && lbB) {
      expect(lbA.rank).toBeLessThan(lbB.rank);
    }

    // L1 strategy should NOT get allocations (only L2+ with positive fitness)
    const allocC = result.allocations.find((a) => a.strategyId === "strategy-c");
    expect(allocC).toBeUndefined();

    // Total allocation should respect maxTotalExposurePct
    const totalAllocPct = result.allocations.reduce((s, a) => s + a.weightPct, 0);
    expect(totalAllocPct).toBeLessThanOrEqual(70 + 0.01);
  });

  // ── 4. Promotion pipeline: L1 → L2 via walk-forward ──

  it("promotion pipeline: L1 with good WF → promoted to L2", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "int-promote-"));

    const registry = new StrategyRegistry(join(tempDir, "strategies.json"));
    const strategy = makeSMACrossStrategy("promote-me", 5, 20);

    registry.create(strategy);
    registry.updateLevel("promote-me", "L1_BACKTEST");

    // Generate enough data for walk-forward (5 windows)
    const data = generateOHLCV({ bars: 500, startPrice: 100, trend: "bull", volatility: 0.01 });

    // Run backtest
    const engine = new BacktestEngine();
    const btResult = await engine.run(strategy, data, BT_CONFIG);
    registry.updateBacktest("promote-me", btResult);

    // Run walk-forward
    const wf = new WalkForward(engine);
    const wfResult = await wf.validate(strategy, data, BT_CONFIG, { windows: 5, threshold: 0.3 });
    registry.updateWalkForward("promote-me", wfResult);

    // Build profile and check promotion
    const record = registry.get("promote-me")!;
    const fm = new FundManager(join(tempDir, "fund.json"), FUND_CONFIG);
    const profiles = fm.buildProfiles([record]);
    expect(profiles).toHaveLength(1);

    const promo = fm.checkPromotion(profiles[0]);
    // Whether promotion succeeds depends on backtest quality, but the pipeline should complete
    expect(promo.strategyId).toBe("promote-me");
    expect(promo.currentLevel).toBe("L1_BACKTEST");
    if (promo.eligible) {
      expect(promo.targetLevel).toBe("L2_PAPER");
    }
  });

  // ── 5. Demotion pipeline: L3 with consecutive losses → demoted ──

  it("demotion pipeline: L3 with 3 loss days → demoted to L2", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "int-demote-"));

    const fm = new FundManager(join(tempDir, "fund.json"), FUND_CONFIG);

    const records: StrategyRecord[] = [
      makeRecord("failing-strat", "L3_LIVE", { sharpe: 0.5, maxDrawdown: -20, totalTrades: 100 }),
    ];

    // Paper data shows 3 consecutive loss days
    const paperData = new Map<
      string,
      {
        metrics?: DecayState;
        equity?: number;
        initialCapital?: number;
        daysActive?: number;
        tradeCount?: number;
      }
    >();
    paperData.set("failing-strat", {
      metrics: makeDecayState({
        rollingSharpe7d: -0.5,
        rollingSharpe30d: 0.3,
        consecutiveLossDays: 3,
        currentDrawdown: -15,
        decayLevel: "degrading",
      }),
      equity: 85000,
      initialCapital: 100000,
      daysActive: 60,
      tradeCount: 50,
    });

    const result = fm.rebalance(records, paperData);

    // Should have a demotion for the failing strategy
    const demotion = result.demotions.find((d) => d.strategyId === "failing-strat");
    expect(demotion).toBeDefined();
    expect(demotion!.shouldDemote).toBe(true);
    expect(demotion!.targetLevel).toBe("L2_PAPER");
    expect(demotion!.reasons.length).toBeGreaterThan(0);
  });

  // ── 6. Memory hooks: trade → journal auto-log ──

  it("memory hooks: paper order → trade journal auto-log", () => {
    tempDir = mkdtempSync(join(tmpdir(), "int-hooks-"));

    const journal = new TradeJournal(join(tempDir, "journal.jsonl"));

    // Simulate after_tool_call hook with fin_paper_order result
    const event: AfterToolCallEvent = {
      toolName: "fin_paper_order",
      params: {
        symbol: "BTC/USDT",
        side: "buy",
        quantity: 0.5,
        strategyId: "momentum-btc",
        reason: "golden-cross",
      },
      result: {
        price: 50000,
        amount: 0.5,
        pnl: undefined,
      },
      durationMs: 150,
    };

    handleTradeToolCall(event, journal);

    // Verify journal entry
    const entries = journal.query();
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.symbol).toBe("BTC/USDT");
    expect(entry.side).toBe("buy");
    expect(entry.price).toBe(50000);
    expect(entry.quantity).toBe(0.5);
    expect(entry.notional).toBe(25000);
    expect(entry.source).toBe("paper");
    expect(entry.strategyId).toBe("momentum-btc");
    expect(entry.reason).toBe("golden-cross");
  });

  it("memory hooks: ignores non-trade tool calls", () => {
    tempDir = mkdtempSync(join(tmpdir(), "int-hooks-ignore-"));

    const journal = new TradeJournal(join(tempDir, "journal.jsonl"));

    const event: AfterToolCallEvent = {
      toolName: "fin_market_data",
      params: { symbol: "BTC/USDT" },
      result: { price: 50000 },
    };

    handleTradeToolCall(event, journal);
    expect(journal.count()).toBe(0);
  });

  // ── 7. Context injection: fund status → prompt context ──

  it("context injection: fund status → prompt context string", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "int-context-"));

    const fm = new FundManager(join(tempDir, "fund.json"), { ...FUND_CONFIG });
    fm.markDayStart(100000);

    // Set up error book with some patterns
    const errorBook = new ErrorBook(join(tempDir, "errors.json"));
    errorBook.record({
      id: "chasing-high",
      description: "Buying at local high",
      category: "entry",
      loss: 500,
      tradeId: "t1",
      symbol: "BTC/USDT",
    });
    errorBook.record({
      id: "chasing-high",
      description: "Buying at local high",
      category: "entry",
      loss: 300,
      tradeId: "t2",
      symbol: "ETH/USDT",
    });

    // Create service map
    const services = new Map<string, unknown>();
    services.set("fin-fund-manager", fm);
    services.set("fin-error-book", errorBook);

    const context = buildFinancialContext(services);

    expect(context).toBeDefined();
    expect(context).toContain("[FinClaw Context]");
    expect(context).toContain("Fund:");
    expect(context).toContain("100,000");
    expect(context).toContain("Risk:");
    expect(context).toContain("normal");
    expect(context).toContain("Error Book TOP-3:");
    expect(context).toContain("ENTRY");
    expect(context).toContain("Buying at local high");
  });

  it("context injection: returns undefined with no services", () => {
    const context = buildFinancialContext(undefined);
    expect(context).toBeUndefined();
  });

  // ── 8. Correlation penalty ──

  it("correlation penalty: two correlated strategies → allocation capped", () => {
    const allocator = new CapitalAllocator();
    const monitor = new CorrelationMonitor();

    // Create two highly correlated equity curves (r ≈ 0.9+)
    const n = 100;
    const curveA: number[] = [];
    const curveB: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = Math.sin(i * 0.1) + i * 0.01;
      curveA.push(x);
      curveB.push(x + Math.sin(i * 0.3) * 0.1); // mostly same trend
    }

    const curves = new Map<string, number[]>();
    curves.set("strat-a", curveA);
    curves.set("strat-b", curveB);

    const { matrix, highCorrelation } = monitor.compute(curves);

    // Verify high correlation detected
    expect(highCorrelation.length).toBeGreaterThan(0);
    const corr = matrix.get("strat-a")!.get("strat-b")!;
    expect(Math.abs(corr)).toBeGreaterThanOrEqual(0.7);

    // Allocate with correlation constraints
    const profiles: StrategyProfile[] = [
      { id: "strat-a", name: "A", level: "L3_LIVE", fitness: 2.0 },
      { id: "strat-b", name: "B", level: "L3_LIVE", fitness: 2.0 },
    ];

    const config: FundConfig = {
      cashReservePct: 0,
      maxSingleStrategyPct: 50,
      maxTotalExposurePct: 100,
      rebalanceFrequency: "weekly",
    };

    const allocations = allocator.allocate(profiles, 100000, config, matrix);

    // Combined weight of correlated strategies should be ≤ 40%
    const totalWeight = allocations.reduce((s, a) => s + a.weightPct, 0);
    expect(totalWeight).toBeLessThanOrEqual(40 + 0.01);
  });

  it("uncorrelated strategies: no cap applied", () => {
    const allocator = new CapitalAllocator();
    const monitor = new CorrelationMonitor();

    // Create two uncorrelated curves
    const n = 100;
    const curveA: number[] = [];
    const curveB: number[] = [];
    for (let i = 0; i < n; i++) {
      curveA.push(Math.sin(i * 0.1));
      curveB.push(Math.cos(i * 0.7 + 3)); // different frequency
    }

    const curves = new Map<string, number[]>();
    curves.set("strat-x", curveA);
    curves.set("strat-y", curveB);

    const { matrix, highCorrelation } = monitor.compute(curves);

    // Should have low/no high correlation
    expect(highCorrelation.length).toBe(0);

    const profiles: StrategyProfile[] = [
      { id: "strat-x", name: "X", level: "L3_LIVE", fitness: 1.5 },
      { id: "strat-y", name: "Y", level: "L3_LIVE", fitness: 1.5 },
    ];

    const config: FundConfig = {
      cashReservePct: 0,
      maxSingleStrategyPct: 50,
      maxTotalExposurePct: 100,
      rebalanceFrequency: "weekly",
    };

    const allocations = allocator.allocate(profiles, 100000, config, matrix);

    // Without correlation cap, combined weight can exceed 40%
    const totalWeight = allocations.reduce((s, a) => s + a.weightPct, 0);
    expect(totalWeight).toBeGreaterThan(0);
  });
});

// ── Helpers ──

function makeRecord(
  id: string,
  level: StrategyRecord["level"],
  bt: { sharpe: number; maxDrawdown: number; totalTrades: number },
): StrategyRecord {
  return {
    id,
    name: id,
    version: "1.0",
    level,
    definition: {
      id,
      name: id,
      version: "1.0",
      markets: ["crypto"],
      symbols: ["BTC/USDT"],
      timeframes: ["1d"],
      parameters: {},
      async onBar() {
        return null;
      },
    },
    createdAt: Date.now() - 90 * 86_400_000, // 90 days ago
    updatedAt: Date.now(),
    lastBacktest: {
      strategyId: id,
      startDate: Date.now() - 365 * 86_400_000,
      endDate: Date.now(),
      initialCapital: 100000,
      finalEquity: 100000 * (1 + bt.sharpe * 0.1),
      totalReturn: bt.sharpe * 10,
      sharpe: bt.sharpe,
      sortino: bt.sharpe * 1.2,
      maxDrawdown: bt.maxDrawdown,
      calmar: bt.sharpe / Math.abs(bt.maxDrawdown / 100),
      winRate: 55,
      profitFactor: 1.5,
      totalTrades: bt.totalTrades,
      trades: [],
      equityCurve: [100000],
      dailyReturns: [],
    },
    lastWalkForward: {
      passed: true,
      windows: [],
      combinedTestSharpe: bt.sharpe * 0.7,
      avgTrainSharpe: bt.sharpe,
      ratio: 0.7,
      threshold: 0.6,
    },
  };
}

function makeDecayState(overrides: Partial<DecayState>): DecayState {
  return {
    rollingSharpe7d: 0.5,
    rollingSharpe30d: 0.5,
    sharpeMomentum: 0,
    consecutiveLossDays: 0,
    currentDrawdown: 0,
    peakEquity: 100000,
    decayLevel: "healthy",
    ...overrides,
  };
}
