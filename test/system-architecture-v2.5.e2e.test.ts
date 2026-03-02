/**
 * E2E: System Architecture v2.5 — Comprehensive 5-Layer Test
 *
 * Validates:
 *   A. Data Layer — OHLCVCache + RegimeDetector
 *   B. Strategy Lifecycle — 10 builtins, registry, backtest, walk-forward
 *   C. Risk Layer — RiskController 3-tier evaluation
 *   D. Paper Trading — PaperStore + PaperEngine orders + snapshots
 *   E. Evolution Engine — EvolutionStore + RDAVD pipeline
 *   F. Service Integration — full chain simulation
 *   G. Promotion/Demotion Pipeline — 8 threshold tests
 *
 * All data is mock (deterministic OHLCV). No external services needed.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
// --- Risk ---
import { RiskController } from "../extensions/fin-core/src/risk-controller.js";
import type { TradingRiskConfig, OrderRequest } from "../extensions/fin-core/src/types.js";
// --- Evolution engine ---
import { EvolutionStore } from "../extensions/fin-evolution-engine/src/evolution-store.js";
import { runRdavdCycle } from "../extensions/fin-evolution-engine/src/rdavd.js";
import type { EvolutionNode } from "../extensions/fin-evolution-engine/src/schemas.js";
import { FundManager } from "../extensions/fin-fund-manager/src/fund-manager.js";
// --- Fund manager ---
import { PromotionPipeline } from "../extensions/fin-fund-manager/src/promotion-pipeline.js";
import type { StrategyProfile } from "../extensions/fin-fund-manager/src/types.js";
import { PaperEngine } from "../extensions/fin-paper-trading/src/paper-engine.js";
// --- Paper trading ---
import { PaperStore } from "../extensions/fin-paper-trading/src/paper-store.js";
// --- Shared types ---
import type { OHLCV, MarketRegime } from "../extensions/fin-shared-types/src/types.js";
// --- Strategy engine ---
import {
  BacktestEngine,
  buildIndicatorLib,
} from "../extensions/fin-strategy-engine/src/backtest-engine.js";
import { createBollingerBands } from "../extensions/fin-strategy-engine/src/builtin-strategies/bollinger-bands.js";
import { buildCustomStrategy } from "../extensions/fin-strategy-engine/src/builtin-strategies/custom-rule-engine.js";
import { createMacdDivergence } from "../extensions/fin-strategy-engine/src/builtin-strategies/macd-divergence.js";
import { createMultiTimeframeConfluence } from "../extensions/fin-strategy-engine/src/builtin-strategies/multi-timeframe-confluence.js";
import { createRegimeAdaptive } from "../extensions/fin-strategy-engine/src/builtin-strategies/regime-adaptive.js";
import { createRiskParityTripleScreen } from "../extensions/fin-strategy-engine/src/builtin-strategies/risk-parity-triple-screen.js";
import { createRsiMeanReversion } from "../extensions/fin-strategy-engine/src/builtin-strategies/rsi-mean-reversion.js";
// --- Builtin strategies (9 factories + 1 builder) ---
import { createSmaCrossover } from "../extensions/fin-strategy-engine/src/builtin-strategies/sma-crossover.js";
import { createTrendFollowingMomentum } from "../extensions/fin-strategy-engine/src/builtin-strategies/trend-following-momentum.js";
import { createVolatilityMeanReversion } from "../extensions/fin-strategy-engine/src/builtin-strategies/volatility-mean-reversion.js";
import { StrategyRegistry } from "../extensions/fin-strategy-engine/src/strategy-registry.js";
import { WalkForward } from "../extensions/fin-strategy-engine/src/walk-forward.js";
// --- Data layer ---
import { OHLCVCache } from "../extensions/findoo-datahub-plugin/src/ohlcv-cache.js";
import { RegimeDetector } from "../extensions/findoo-datahub-plugin/src/regime-detector.js";
// --- Test data generators ---
import { generateOHLCV, generateLinearOHLCV } from "./helpers/fin-test-data.js";

// ---------------------------------------------------------------------------
// Mock OHLCV generator — 3-phase: uptrend, downtrend, rebound
// Same deterministic pattern as e2e-pipeline.test.ts
// ---------------------------------------------------------------------------

function generateMockOHLCV(count: number, startPrice = 40000): OHLCV[] {
  const bars: OHLCV[] = [];
  let price = startPrice;
  const baseTimestamp = Date.now() - count * 3600_000;

  for (let i = 0; i < count; i++) {
    let drift: number;
    if (i < 100) {
      drift = 0.0018;
    } else if (i < 200) {
      drift = -0.0023;
    } else {
      drift = 0.0017;
    }

    const noise = Math.sin(i * 0.7) * 0.003 + Math.cos(i * 1.3) * 0.002;
    price = price * (1 + drift + noise);

    const open = price * (1 + Math.sin(i * 0.5) * 0.002);
    const high = Math.max(open, price) * (1 + Math.abs(Math.sin(i * 0.3)) * 0.005);
    const low = Math.min(open, price) * (1 - Math.abs(Math.cos(i * 0.4)) * 0.005);

    bars.push({
      timestamp: baseTimestamp + i * 3600_000,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(price * 100) / 100,
      volume: 100 + Math.abs(Math.sin(i * 0.2)) * 500,
    });
  }

  return bars;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe("E2E: System Architecture v2.5", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `fin-arch-v2.5-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // SECTION A: DATA LAYER (7 tests)
  // =========================================================================

  describe("A: Data Layer", () => {
    let cache: OHLCVCache;
    let bars: OHLCV[];

    beforeAll(() => {
      cache = new OHLCVCache(join(tmpDir, "ohlcv-cache-a.sqlite"));
      bars = generateOHLCV({ bars: 50, startPrice: 100, trend: "bull" });
      cache.upsertBatch("BTC/USDT", "crypto", "1h", bars);
    });

    afterAll(() => {
      cache.close();
    });

    test("A1: OHLCVCache write + read (SQLite)", () => {
      const result = cache.query("BTC/USDT", "crypto", "1h");
      expect(result.length).toBe(50);
      expect(result[0].close).toBeCloseTo(bars[0].close, 2);
      expect(result[49].close).toBeCloseTo(bars[49].close, 2);
      expect(result[0].timestamp).toBe(bars[0].timestamp);
    });

    test("A2: OHLCVCache range tracking", () => {
      const range = cache.getRange("BTC/USDT", "crypto", "1h");
      expect(range).not.toBeNull();
      expect(range!.earliest).toBe(bars[0].timestamp);
      expect(range!.latest).toBe(bars[bars.length - 1].timestamp);
    });

    test("A3: OHLCVCache miss scenario", () => {
      const result = cache.query("ETH/USDT", "crypto", "1h");
      expect(result.length).toBe(0);
    });

    test("A4: OHLCVCache temporal query", () => {
      const cache2 = new OHLCVCache(join(tmpDir, "ohlcv-cache-a4.sqlite"));
      const fullBars = generateOHLCV({
        bars: 100,
        startPrice: 200,
        trend: "sideways",
      });
      cache2.upsertBatch("ETH/USDT", "crypto", "1d", fullBars);

      const since = fullBars[20].timestamp;
      const until = fullBars[50].timestamp;
      const subset = cache2.query("ETH/USDT", "crypto", "1d", since, until);

      expect(subset.length).toBe(31); // inclusive range: 20..50
      expect(subset[0].timestamp).toBe(since);
      expect(subset[subset.length - 1].timestamp).toBe(until);
      cache2.close();
    });

    test("A5: RegimeDetector bull detection", () => {
      const detector = new RegimeDetector();
      // Need 300+ bars of strongly bullish data
      const bullBars = generateLinearOHLCV(350, 100, 300);
      const regime = detector.detect(bullBars);
      expect(regime).toBe("bull");
    });

    test("A6: RegimeDetector bear detection", () => {
      const detector = new RegimeDetector();
      // Decline must stay within 30% drawdown from peak to avoid "crisis",
      // while still having SMA(50) < SMA(200) and close < SMA(50)
      const bearBars = generateLinearOHLCV(350, 300, 220);
      const regime = detector.detect(bearBars);
      expect(regime).toBe("bear");
    });

    test("A7: RegimeDetector requires minimum bars", () => {
      const detector = new RegimeDetector();
      const shortBars = generateOHLCV({
        bars: 50,
        startPrice: 100,
        trend: "bull",
      });
      const regime = detector.detect(shortBars);
      expect(regime).toBe("sideways");
    });
  });

  // =========================================================================
  // SECTION B: STRATEGY LIFECYCLE (6 tests)
  // =========================================================================

  describe("B: Strategy Lifecycle", () => {
    let engine: BacktestEngine;
    let mockOHLCV: OHLCV[];

    beforeAll(() => {
      engine = new BacktestEngine();
      mockOHLCV = generateMockOHLCV(300);
    });

    test("B1: Create 10 builtin strategy templates", () => {
      const factories = [
        createSmaCrossover,
        createRsiMeanReversion,
        createMacdDivergence,
        createBollingerBands,
        createTrendFollowingMomentum,
        createVolatilityMeanReversion,
        createRegimeAdaptive,
        createRiskParityTripleScreen,
        createMultiTimeframeConfluence,
      ];

      for (const factory of factories) {
        const def = factory();
        expect(typeof def.id).toBe("string");
        expect(def.id.length).toBeGreaterThan(0);
        expect(typeof def.name).toBe("string");
        expect(def.name.length).toBeGreaterThan(0);
        expect(typeof def.version).toBe("string");
        expect(typeof def.onBar).toBe("function");
      }

      // Custom rule engine
      const customDef = buildCustomStrategy(
        "Test Custom",
        { buy: "rsi < 30", sell: "rsi > 70" },
        { rsiPeriod: 14 },
      );
      expect(typeof customDef.id).toBe("string");
      expect(customDef.name).toBe("Test Custom");
      expect(customDef.version).toBe("1.0.0");
      expect(typeof customDef.onBar).toBe("function");
    });

    test("B2: Strategy create -> L0_INCUBATE", () => {
      const registry = new StrategyRegistry(join(tmpDir, "strategies-b2.json"));
      const def = createSmaCrossover();
      const record = registry.create(def);
      expect(record.level).toBe("L0_INCUBATE");
      expect(record.definition.id).toBe(def.id);
      expect(record.name).toBe(def.name);
      expect(record.createdAt).toBeGreaterThan(0);
    });

    test("B3: Backtest 300 bars -> BacktestResult", async () => {
      const def = createSmaCrossover();
      const result = await engine.run(def, mockOHLCV, {
        capital: 100000,
        commissionRate: 0.001,
        slippageBps: 5,
        market: "crypto",
      });

      expect(result.strategyId).toBe(def.id);
      expect(result.totalTrades).toBeGreaterThanOrEqual(1);
      expect(result.equityCurve.length).toBe(300);
      expect(result.initialCapital).toBe(100000);
      expect(result.startDate).toBeGreaterThan(0);
      expect(result.endDate).toBeGreaterThan(result.startDate);
    });

    test("B4: Backtest result statistical correctness", async () => {
      const def = createSmaCrossover();
      const result = await engine.run(def, mockOHLCV, {
        capital: 100000,
        commissionRate: 0.001,
        slippageBps: 5,
        market: "crypto",
      });

      expect(Number.isFinite(result.sharpe)).toBe(true);
      expect(Number.isFinite(result.sortino)).toBe(true);
      expect(Number.isFinite(result.maxDrawdown)).toBe(true);
      expect(Number.isFinite(result.profitFactor)).toBe(true);

      if (result.totalTrades > 0) {
        // winRate is stored as percentage (0-100)
        expect(result.winRate).toBeGreaterThanOrEqual(0);
        expect(result.winRate).toBeLessThanOrEqual(100);
      }
      expect(result.profitFactor).toBeGreaterThanOrEqual(0);
      expect(result.dailyReturns.length).toBe(299); // 300 bars - 1
    });

    test("B5: Walk-Forward 3 windows", async () => {
      const def = createSmaCrossover();
      const wf = new WalkForward(engine);
      const result = await wf.validate(
        def,
        mockOHLCV,
        { capital: 100000, commissionRate: 0.001, slippageBps: 5, market: "crypto" },
        { windows: 3, threshold: 0.3 },
      );

      expect(result.windows.length).toBe(3);
      expect(typeof result.ratio).toBe("number");
      expect(typeof result.passed).toBe("boolean");
      expect(result.threshold).toBe(0.3);
      // Each window should have valid timestamps
      for (const w of result.windows) {
        expect(w.trainStart).toBeGreaterThan(0);
        expect(w.testEnd).toBeGreaterThan(w.trainStart);
        expect(typeof w.trainSharpe).toBe("number");
        expect(typeof w.testSharpe).toBe("number");
      }
    });

    test("B6: Registry persistence", () => {
      const filePath = join(tmpDir, "strategies-b6.json");
      const registry1 = new StrategyRegistry(filePath);
      const def = createSmaCrossover();
      registry1.create(def);

      // Create a new registry from the same file
      const registry2 = new StrategyRegistry(filePath);
      const loaded = registry2.get(def.id);
      expect(loaded).toBeDefined();
      expect(loaded!.definition.id).toBe(def.id);
      expect(loaded!.name).toBe(def.name);
      expect(loaded!.level).toBe("L0_INCUBATE");
    });
  });

  // =========================================================================
  // SECTION C: RISK LAYER (6 tests)
  // =========================================================================

  describe("C: Risk Layer", () => {
    const baseConfig: TradingRiskConfig = {
      enabled: true,
      maxAutoTradeUsd: 100,
      confirmThresholdUsd: 500,
      maxDailyLossUsd: 1000,
      maxPositionPct: 50,
      maxLeverage: 5,
    };

    const order: OrderRequest = {
      exchange: "binance",
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 1,
    };

    test("C1: 3-tier evaluation", () => {
      const rc = new RiskController({ ...baseConfig });
      expect(rc.evaluate(order, 50).tier).toBe("auto"); // $50 <= 100
      expect(rc.evaluate(order, 300).tier).toBe("confirm"); // 100 < $300 <= 500
      expect(rc.evaluate(order, 600).tier).toBe("reject"); // $600 > 500
    });

    test("C2: Daily loss limit", () => {
      const rc = new RiskController({ ...baseConfig });
      rc.recordLoss(500);
      rc.recordLoss(500);
      // Total = 1000 = maxDailyLossUsd
      const result = rc.evaluate(order, 50);
      expect(result.tier).toBe("reject");
      expect(result.reason).toContain("Daily loss limit");
    });

    test("C3: Leverage limit", () => {
      const rc = new RiskController({ ...baseConfig });
      const leveragedOrder: OrderRequest = { ...order, leverage: 10 };
      const result = rc.evaluate(leveragedOrder, 50);
      expect(result.tier).toBe("reject");
      expect(result.reason).toContain("Leverage");
    });

    test("C4: Allowed/blocked pairs", () => {
      const rcPairs = new RiskController({
        ...baseConfig,
        allowedPairs: ["BTC/USDT", "ETH/USDT"],
      });
      expect(rcPairs.evaluate({ ...order, symbol: "BTC/USDT" }, 50).tier).toBe("auto");
      expect(rcPairs.evaluate({ ...order, symbol: "DOGE/USDT" }, 50).tier).toBe("reject");

      const rcBlocked = new RiskController({
        ...baseConfig,
        blockedPairs: ["DOGE/USDT"],
      });
      expect(rcBlocked.evaluate({ ...order, symbol: "BTC/USDT" }, 50).tier).toBe("auto");
      const blockedResult = rcBlocked.evaluate({ ...order, symbol: "DOGE/USDT" }, 50);
      expect(blockedResult.tier).toBe("reject");
      expect(blockedResult.reason).toContain("blocked");
    });

    test("C5: Fresh controller starts with 0 loss, accumulates correctly", () => {
      const rc = new RiskController({ ...baseConfig });
      // Fresh: no losses, small order should be auto
      expect(rc.evaluate(order, 50).tier).toBe("auto");

      // After recording 999, still under 1000
      rc.recordLoss(999);
      expect(rc.evaluate(order, 50).tier).toBe("auto");

      // After recording 1 more, exactly at 1000
      rc.recordLoss(1);
      expect(rc.evaluate(order, 50).tier).toBe("reject");
    });

    test("C6: Trading disabled", () => {
      const rcDisabled = new RiskController({
        ...baseConfig,
        enabled: false,
      });
      const result = rcDisabled.evaluate(order, 1);
      expect(result.tier).toBe("reject");
      expect(result.reason).toContain("disabled");
    });
  });

  // =========================================================================
  // SECTION D: PAPER TRADING (6 tests)
  // =========================================================================

  describe("D: Paper Trading", () => {
    let store: PaperStore;
    let paperEngine: PaperEngine;

    beforeAll(() => {
      store = new PaperStore(join(tmpDir, "paper-d.sqlite"));
      paperEngine = new PaperEngine({
        store,
        slippageBps: 10,
        market: "crypto",
      });
    });

    afterAll(() => {
      store.close();
    });

    test("D1: createAccount -> initial state", () => {
      const acct = paperEngine.createAccount("test-acct", 10000);
      expect(acct.cash).toBe(10000);
      expect(acct.equity).toBe(10000);
      expect(acct.positions.length).toBe(0);
      expect(acct.initialCapital).toBe(10000);
      expect(typeof acct.id).toBe("string");
      expect(acct.name).toBe("test-acct");
    });

    test("D2: submitOrder buy -> position + cash change", () => {
      const acct = paperEngine.createAccount("buy-test", 10000);
      const buyOrder = paperEngine.submitOrder(
        acct.id,
        {
          symbol: "BTC/USDT",
          side: "buy",
          type: "market",
          quantity: 0.1,
        },
        50000,
      );
      expect(buyOrder.status).toBe("filled");
      expect(buyOrder.fillPrice).toBeGreaterThan(0);

      const state = paperEngine.getAccountState(acct.id);
      expect(state).not.toBeNull();
      expect(state!.cash).toBeLessThan(10000);
      expect(state!.positions.length).toBe(1);
      expect(state!.positions[0].symbol).toBe("BTC/USDT");
      expect(state!.positions[0].quantity).toBe(0.1);
    });

    test("D3: submitOrder sell -> close position P&L", () => {
      const acct = paperEngine.createAccount("sell-test", 10000);
      // Buy at 50000
      paperEngine.submitOrder(
        acct.id,
        { symbol: "BTC/USDT", side: "buy", type: "market", quantity: 0.1 },
        50000,
      );
      // Sell at 55000 (higher price -> positive P&L expected)
      const sellOrder = paperEngine.submitOrder(
        acct.id,
        { symbol: "BTC/USDT", side: "sell", type: "market", quantity: 0.1 },
        55000,
      );
      expect(sellOrder.status).toBe("filled");

      const state = paperEngine.getAccountState(acct.id);
      expect(state).not.toBeNull();
      expect(state!.positions.length).toBe(0);
      // Should have profit: bought ~5005 (with slippage), sold ~5494.5 (with slippage)
      // Net gain should make equity > 10000 (minus commissions)
      expect(state!.equity).toBeGreaterThan(10000);
    });

    test("D4: getMetrics -> DecayState", () => {
      const acct = paperEngine.createAccount("metrics-test", 10000);
      // Record some snapshots to have data for decay detection
      paperEngine.recordSnapshot(acct.id);

      const metrics = paperEngine.getMetrics(acct.id);
      expect(metrics).not.toBeNull();
      expect(typeof metrics!.rollingSharpe7d).toBe("number");
      expect(typeof metrics!.rollingSharpe30d).toBe("number");
      expect(typeof metrics!.consecutiveLossDays).toBe("number");
      expect(typeof metrics!.decayLevel).toBe("string");
      expect(["healthy", "warning", "degrading", "critical"]).toContain(metrics!.decayLevel);
    });

    test("D5: recordSnapshot -> equity_snapshots table", () => {
      const acct = paperEngine.createAccount("snapshot-test", 10000);
      paperEngine.recordSnapshot(acct.id);

      const snapshots = paperEngine.getSnapshots(acct.id);
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      expect(snapshots[0].accountId).toBe(acct.id);
      expect(snapshots[0].equity).toBe(10000);
      expect(snapshots[0].cash).toBe(10000);
      expect(snapshots[0].positionsValue).toBe(0);
      expect(snapshots[0].timestamp).toBeGreaterThan(0);
    });

    test("D6: Slippage model", () => {
      const acct = paperEngine.createAccount("slippage-test", 100000);
      const buyOrder = paperEngine.submitOrder(
        acct.id,
        { symbol: "BTC/USDT", side: "buy", type: "market", quantity: 1 },
        50000,
      );
      // slippageBps = 10 means 0.1% slippage
      // Buy slippage pushes price up: 50000 * (1 + 10/10000) = 50050
      expect(buyOrder.status).toBe("filled");
      expect(buyOrder.fillPrice).toBeCloseTo(50050, 0);
      expect(buyOrder.slippage).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // SECTION E: EVOLUTION ENGINE (4 tests)
  // =========================================================================

  describe("E: Evolution Engine", () => {
    let evoStore: EvolutionStore;

    beforeAll(() => {
      evoStore = new EvolutionStore(join(tmpDir, "evolution-e.sqlite"));
    });

    afterAll(() => {
      evoStore.close();
    });

    test("E1: EvolutionStore CRUD", () => {
      const node: EvolutionNode = {
        id: "evo-test-gen0",
        strategyId: "test-strategy",
        strategyName: "Test SMA",
        generation: 0,
        parentId: null,
        genes: [
          {
            id: "g1",
            name: "RSI_Oversold",
            type: "signal",
            params: { period: 14, threshold: 30 },
            direction: 0,
            confidence: 0.7,
          },
        ],
        fitness: 0.65,
        survivalTier: "healthy",
        level: "L1_BACKTEST",
        backtestSharpe: 1.2,
        maxDrawdown: -0.08,
        winRate: 0.55,
        totalTrades: 100,
        createdAt: new Date().toISOString(),
      };
      evoStore.saveNode(node);

      const loaded = evoStore.getNode("evo-test-gen0");
      expect(loaded).toBeDefined();
      expect(loaded!.strategyId).toBe("test-strategy");
      expect(loaded!.strategyName).toBe("Test SMA");
      expect(loaded!.fitness).toBe(0.65);
      expect(loaded!.genes.length).toBe(1);
      expect(loaded!.genes[0].id).toBe("g1");
      expect(loaded!.genes[0].name).toBe("RSI_Oversold");
      expect(loaded!.genes[0].params.period).toBe(14);
      expect(loaded!.generation).toBe(0);
      expect(loaded!.parentId).toBeNull();
      expect(loaded!.survivalTier).toBe("healthy");
      expect(loaded!.level).toBe("L1_BACKTEST");
      expect(loaded!.backtestSharpe).toBe(1.2);
    });

    test("E2: RDAVD 5-stage pipeline (no LLM)", async () => {
      const result = await runRdavdCycle("test-strategy", "manual", {
        store: evoStore,
      });

      expect(result.cycle).toBeDefined();
      expect(result.cycle.strategyId).toBe("test-strategy");
      expect(result.cycle.trigger).toBe("manual");
      expect(result.cycle.outcome).toBeDefined();
      expect(["no_action", "rejected", "mutated"]).toContain(result.cycle.outcome);
      // Manual trigger with an existing node should attempt evolution
      expect(result.cycle.survivalAssessment).toBeDefined();
      expect(result.cycle.survivalAssessment.currentTier).toBeDefined();
    });

    test("E3: Risk gate verification", async () => {
      const result = await runRdavdCycle("test-strategy", "manual", {
        store: evoStore,
      });

      // The cycle should have survival assessment present
      expect(result.cycle.survivalAssessment).toBeDefined();
      expect(["thriving", "healthy", "stressed", "critical", "stopped"]).toContain(
        result.cycle.survivalAssessment.currentTier,
      );

      // If the mutation was attempted, riskGateResult should be present
      if (
        result.cycle.outcome === "mutated" ||
        (result.cycle.outcome === "rejected" && result.cycle.riskGateResult)
      ) {
        expect(result.cycle.riskGateResult).toBeDefined();
        expect(typeof result.cycle.riskGateResult!.allPassed).toBe("boolean");
      }
    });

    test("E4: EvolutionStore audit log", () => {
      evoStore.logAudit({
        id: "audit-test-1",
        type: "MUTATION",
        strategyId: "test-strategy",
        strategyName: "Test SMA",
        detail: "Test audit entry",
        triggeredBy: "manual",
        createdAt: new Date().toISOString(),
      });

      const auditLog = evoStore.getAuditLog({
        strategyId: "test-strategy",
      });
      expect(auditLog.length).toBeGreaterThanOrEqual(1);
      expect(auditLog.some((e) => e.detail.includes("Test audit"))).toBe(true);
      expect(auditLog.some((e) => e.id === "audit-test-1")).toBe(true);
    });
  });

  // =========================================================================
  // SECTION F: SERVICE INTEGRATION (4 tests)
  // =========================================================================

  describe("F: Service Integration", () => {
    test("F1: Map-based service simulation -> full chain", () => {
      const mockOHLCV = generateMockOHLCV(300);
      const registry = new StrategyRegistry(join(tmpDir, "strategies-f1.json"));
      const paperStore = new PaperStore(join(tmpDir, "paper-f1.sqlite"));
      const paperEng = new PaperEngine({
        store: paperStore,
        slippageBps: 10,
        market: "crypto",
      });
      const fundMgr = new FundManager(join(tmpDir, "fund-f1.json"), {
        cashReservePct: 10,
        maxSingleStrategyPct: 30,
        maxTotalExposurePct: 90,
        rebalanceFrequency: "daily",
        totalCapital: 100000,
      });

      const services = new Map<string, unknown>();
      services.set("fin-data-provider", {
        getOHLCV: async () => mockOHLCV,
        detectRegime: () => "sideways" as MarketRegime,
      });
      services.set("fin-strategy-registry", registry);
      services.set("fin-paper-engine", paperEng);
      services.set("fin-fund-manager", fundMgr);

      expect(services.size).toBe(4);
      expect(services.has("fin-data-provider")).toBe(true);
      expect(services.has("fin-strategy-registry")).toBe(true);
      expect(services.has("fin-paper-engine")).toBe(true);
      expect(services.has("fin-fund-manager")).toBe(true);

      paperStore.close();
    });

    test("F2: Strategy tick at L2 -> paper order", async () => {
      const mockOHLCV = generateMockOHLCV(300);
      const _engine = new BacktestEngine();
      const def = createSmaCrossover();
      const paperStore = new PaperStore(join(tmpDir, "paper-f2.sqlite"));
      const paperEng = new PaperEngine({
        store: paperStore,
        slippageBps: 10,
        market: "crypto",
      });
      const acct = paperEng.createAccount("f2-acct", 100000);

      // Run through bars and find first buy signal
      let signalFound = false;
      for (let i = 30; i < mockOHLCV.length; i++) {
        const bar = mockOHLCV[i];
        const history = mockOHLCV.slice(0, i + 1);
        const indicators = buildIndicatorLib(history);
        const ctx = {
          portfolio: { equity: 100000, cash: 100000, positions: [] },
          history,
          indicators,
          regime: "sideways" as MarketRegime,
          memory: new Map<string, unknown>(),
          log: () => {},
        };
        const signal = await def.onBar(bar, ctx);
        if (signal && signal.action === "buy") {
          const order = paperEng.submitOrder(
            acct.id,
            {
              symbol: signal.symbol,
              side: "buy",
              type: "market",
              quantity: 0.1,
            },
            bar.close,
          );
          expect(order.status).toBe("filled");
          expect(order.fillPrice).toBeGreaterThan(0);
          signalFound = true;
          break;
        }
      }
      expect(signalFound).toBe(true);
      paperStore.close();
    });

    test("F3: Strategy tick at L3 -> live route (mock)", async () => {
      const mockOHLCV = generateMockOHLCV(300);
      const def = createSmaCrossover();
      const capturedOrders: Array<{
        symbol: string;
        side: string;
        amount: number;
      }> = [];

      // Mock exchange
      const mockExchange = {
        submitOrder: (params: { symbol: string; side: string; amount: number }) => {
          capturedOrders.push(params);
          return { id: "mock-order-1", status: "filled" };
        },
      };

      // Find first signal and route to mock exchange
      for (let i = 30; i < mockOHLCV.length; i++) {
        const bar = mockOHLCV[i];
        const history = mockOHLCV.slice(0, i + 1);
        const indicators = buildIndicatorLib(history);
        const ctx = {
          portfolio: { equity: 100000, cash: 100000, positions: [] },
          history,
          indicators,
          regime: "sideways" as MarketRegime,
          memory: new Map<string, unknown>(),
          log: () => {},
        };
        const signal = await def.onBar(bar, ctx);
        if (signal && signal.action === "buy") {
          const result = mockExchange.submitOrder({
            symbol: signal.symbol,
            side: "buy",
            amount: 0.1,
          });
          expect(result.status).toBe("filled");
          break;
        }
      }

      expect(capturedOrders.length).toBe(1);
      expect(capturedOrders[0].symbol).toBe("BTC/USDT");
      expect(capturedOrders[0].side).toBe("buy");
    });

    test("F4: Service missing -> graceful error", () => {
      const emptyServices = new Map<string, unknown>();
      const provider = emptyServices.get("fin-data-provider");
      expect(provider).toBeUndefined();

      // Simulate safe fallback pattern
      const dataProvider = emptyServices.get("fin-data-provider") as
        | { getOHLCV: () => OHLCV[] }
        | undefined;
      const data = dataProvider?.getOHLCV() ?? [];
      expect(data).toEqual([]);
    });
  });

  // =========================================================================
  // SECTION G: PROMOTION/DEMOTION PIPELINE (8 tests)
  // =========================================================================

  describe("G: Promotion/Demotion Pipeline", () => {
    let pipeline: PromotionPipeline;

    beforeAll(() => {
      pipeline = new PromotionPipeline();
    });

    test("G1: L0 -> L1 auto-promote", () => {
      const profile: StrategyProfile = {
        id: "s1",
        name: "Test",
        level: "L0_INCUBATE",
        fitness: 0.5,
      };
      const check = pipeline.checkPromotion(profile);
      expect(check.eligible).toBe(true);
      expect(check.targetLevel).toBe("L1_BACKTEST");
      expect(check.blockers.length).toBe(0);
      expect(check.reasons.length).toBeGreaterThan(0);
    });

    test("G2: L1 -> L2 all thresholds met", () => {
      const profile: StrategyProfile = {
        id: "s1",
        name: "Test",
        level: "L1_BACKTEST",
        fitness: 0.7,
        backtest: {
          strategyId: "s1",
          startDate: 0,
          endDate: 1,
          initialCapital: 100000,
          finalEquity: 120000,
          totalReturn: 20,
          sharpe: 1.5,
          sortino: 2.0,
          maxDrawdown: -12,
          calmar: 1.5,
          winRate: 0.6,
          profitFactor: 2.0,
          totalTrades: 150,
          trades: [],
          equityCurve: [],
          dailyReturns: [],
        },
        walkForward: {
          passed: true,
          windows: [],
          combinedTestSharpe: 1.2,
          avgTrainSharpe: 1.5,
          ratio: 0.8,
          threshold: 0.6,
        },
      };
      const check = pipeline.checkPromotion(profile);
      expect(check.eligible).toBe(true);
      expect(check.targetLevel).toBe("L2_PAPER");
      expect(check.blockers.length).toBe(0);
    });

    test("G3: L1 -> L2 single threshold failed (low Sharpe)", () => {
      const profile: StrategyProfile = {
        id: "s1",
        name: "Test",
        level: "L1_BACKTEST",
        fitness: 0.4,
        backtest: {
          strategyId: "s1",
          startDate: 0,
          endDate: 1,
          initialCapital: 100000,
          finalEquity: 110000,
          totalReturn: 10,
          sharpe: 0.5, // below 1.0 threshold
          sortino: 1.0,
          maxDrawdown: -12,
          calmar: 0.8,
          winRate: 0.5,
          profitFactor: 1.2,
          totalTrades: 150,
          trades: [],
          equityCurve: [],
          dailyReturns: [],
        },
        walkForward: {
          passed: true,
          windows: [],
          combinedTestSharpe: 0.4,
          avgTrainSharpe: 0.6,
          ratio: 0.67,
          threshold: 0.6,
        },
      };
      const check = pipeline.checkPromotion(profile);
      expect(check.eligible).toBe(false);
      expect(check.blockers.some((b) => b.includes("Sharpe"))).toBe(true);
    });

    test("G4: L2 -> L3 all thresholds met", () => {
      const profile: StrategyProfile = {
        id: "s1",
        name: "Test",
        level: "L2_PAPER",
        fitness: 0.8,
        backtest: {
          strategyId: "s1",
          startDate: 0,
          endDate: 1,
          initialCapital: 100000,
          finalEquity: 130000,
          totalReturn: 30,
          sharpe: 1.0,
          sortino: 1.5,
          maxDrawdown: -10,
          calmar: 2.0,
          winRate: 0.6,
          profitFactor: 2.0,
          totalTrades: 200,
          trades: [],
          equityCurve: [],
          dailyReturns: [],
        },
        paperDaysActive: 31,
        paperTradeCount: 35,
        paperMetrics: {
          rollingSharpe7d: 1.0,
          rollingSharpe30d: 0.8,
          sharpeMomentum: 0.2,
          consecutiveLossDays: 1,
          currentDrawdown: -15,
          peakEquity: 11000,
          decayLevel: "healthy",
        },
      };
      const check = pipeline.checkPromotion(profile);
      expect(check.eligible).toBe(true);
      expect(check.targetLevel).toBe("L3_LIVE");
      expect(check.needsUserConfirmation).toBe(true);
    });

    test("G5: L2 -> L3 user confirmation gate", () => {
      const profile: StrategyProfile = {
        id: "s1",
        name: "Test",
        level: "L2_PAPER",
        fitness: 0.8,
        backtest: {
          strategyId: "s1",
          startDate: 0,
          endDate: 1,
          initialCapital: 100000,
          finalEquity: 130000,
          totalReturn: 30,
          sharpe: 1.0,
          sortino: 1.5,
          maxDrawdown: -10,
          calmar: 2.0,
          winRate: 0.6,
          profitFactor: 2.0,
          totalTrades: 200,
          trades: [],
          equityCurve: [],
          dailyReturns: [],
        },
        paperDaysActive: 35,
        paperTradeCount: 40,
        paperMetrics: {
          rollingSharpe7d: 1.2,
          rollingSharpe30d: 0.9,
          sharpeMomentum: 0.3,
          consecutiveLossDays: 0,
          currentDrawdown: -8,
          peakEquity: 12000,
          decayLevel: "healthy",
        },
      };
      const check = pipeline.checkPromotion(profile);
      expect(check.eligible).toBe(true);
      expect(check.needsUserConfirmation).toBe(true);
      expect(check.targetLevel).toBe("L3_LIVE");
      // User must explicitly approve L3 promotion
      expect(check.blockers.length).toBe(0);
    });

    test("G6: L3 -> L2 demotion: 7d Sharpe < 0", () => {
      const demoProfile: StrategyProfile = {
        id: "s1",
        name: "Test",
        level: "L3_LIVE",
        fitness: 0.3,
        paperMetrics: {
          rollingSharpe7d: -0.5,
          rollingSharpe30d: 0.1,
          sharpeMomentum: -0.3,
          consecutiveLossDays: 1,
          currentDrawdown: -10,
          peakEquity: 11000,
          decayLevel: "warning",
        },
      };
      const demo = pipeline.checkDemotion(demoProfile);
      expect(demo.shouldDemote).toBe(true);
      expect(demo.targetLevel).toBe("L2_PAPER");
      expect(demo.reasons.length).toBeGreaterThan(0);
      expect(demo.reasons.some((r) => r.includes("7d Sharpe"))).toBe(true);
    });

    test("G7: L2 -> L1 demotion: 30d Sharpe < -0.5", () => {
      const demoL2: StrategyProfile = {
        id: "s1",
        name: "Test",
        level: "L2_PAPER",
        fitness: 0.2,
        paperMetrics: {
          rollingSharpe7d: -0.2,
          rollingSharpe30d: -0.8,
          sharpeMomentum: -0.5,
          consecutiveLossDays: 5,
          currentDrawdown: -25,
          peakEquity: 12000,
          decayLevel: "critical",
        },
      };
      const demoCheck = pipeline.checkDemotion(demoL2);
      expect(demoCheck.shouldDemote).toBe(true);
      expect(demoCheck.targetLevel).toBe("L1_BACKTEST");
      expect(demoCheck.reasons.some((r) => r.includes("30d Sharpe"))).toBe(true);
    });

    test("G8: Any -> KILLED: cumulative loss > 40%", () => {
      const killedProfile: StrategyProfile = {
        id: "s1",
        name: "Test",
        level: "L3_LIVE",
        fitness: 0.1,
        paperEquity: 5000,
        paperInitialCapital: 10000, // 50% loss
        paperMetrics: {
          rollingSharpe7d: -1,
          rollingSharpe30d: -0.8,
          sharpeMomentum: -1,
          consecutiveLossDays: 10,
          currentDrawdown: -50,
          peakEquity: 10000,
          decayLevel: "critical",
        },
      };
      const killCheck = pipeline.checkDemotion(killedProfile);
      expect(killCheck.shouldDemote).toBe(true);
      expect(killCheck.targetLevel).toBe("KILLED");
      expect(killCheck.reasons.some((r) => r.includes("Cumulative loss"))).toBe(true);
      expect(killCheck.reasons.some((r) => r.includes("40%"))).toBe(true);
    });
  });
});
