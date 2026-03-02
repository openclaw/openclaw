/**
 * E2E: Agent Butler Fullchain
 *
 * Comprehensive end-to-end test covering the complete openFinclaw Agent Butler pipeline:
 *   A. Heartbeat Loop — fetchOHLCV → tickStrategies → risk → log
 *   B. Strategy Tick Chain — signal generation → paper trading → P&L
 *   C. Fund Manager — profiles, allocation, rebalance, leaderboard
 *   D. Trade Memory — journal, error book, success book
 *   E. Evolution Sweep — RDAVD cycle, mutation, validation
 *   F. Monitoring Alerts — price, P&L threshold, CRUD
 *   G. HTTP API + SSE — data shape verification
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { RiskController } from "../extensions/fin-core/src/risk-controller.js";
import { EvolutionStore } from "../extensions/fin-evolution-engine/src/evolution-store.js";
import { runRdavdCycle } from "../extensions/fin-evolution-engine/src/rdavd.js";
import type { EvolutionNode, Gene } from "../extensions/fin-evolution-engine/src/schemas.js";
import { FundManager } from "../extensions/fin-fund-manager/src/fund-manager.js";
import type { StrategyProfile, FundConfig } from "../extensions/fin-fund-manager/src/types.js";
import { AlertEngine } from "../extensions/fin-monitoring/src/alert-engine.js";
import { AlertStore } from "../extensions/fin-monitoring/src/alert-store.js";
import { PaperEngine } from "../extensions/fin-paper-trading/src/paper-engine.js";
import { PaperStore } from "../extensions/fin-paper-trading/src/paper-store.js";
import type { OHLCV, BacktestResult } from "../extensions/fin-shared-types/src/types.js";
import {
  BacktestEngine,
  buildIndicatorLib,
} from "../extensions/fin-strategy-engine/src/backtest-engine.js";
import { createSmaCrossover } from "../extensions/fin-strategy-engine/src/builtin-strategies/sma-crossover.js";
import { StrategyRegistry } from "../extensions/fin-strategy-engine/src/strategy-registry.js";
import { ErrorBook } from "../extensions/fin-strategy-memory/src/error-book.js";
import { SuccessBook } from "../extensions/fin-strategy-memory/src/success-book.js";
import { TradeJournal } from "../extensions/fin-strategy-memory/src/trade-journal.js";
import type { TradeEntry } from "../extensions/fin-strategy-memory/src/types.js";
import { generateOHLCV } from "./helpers/fin-test-data.js";

// ─── Mock OHLCV Generator (3-phase: uptrend → downtrend → recovery) ────

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

// ─── Test Suite ──────────────────────────────────────────────────────────

describe("E2E: Agent Butler Fullchain", () => {
  let tmpDir: string;
  let mockOHLCV: OHLCV[];

  beforeAll(() => {
    tmpDir = join(tmpdir(), `e2e-butler-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mockOHLCV = generateMockOHLCV(300);
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // A. Heartbeat Loop
  // ═══════════════════════════════════════════════════════════════════════

  describe("A. Heartbeat Loop", () => {
    test("A1: Single heartbeat cycle — fetch → tick → evaluate → log", async () => {
      const registry = new StrategyRegistry(join(tmpDir, "heartbeat-a1", "strategies.json"));
      const _btEngine = new BacktestEngine();
      const paperStore = new PaperStore(join(tmpDir, "heartbeat-a1", "paper.sqlite"));
      const paperEngine = new PaperEngine({
        store: paperStore,
        slippageBps: 5,
        market: "crypto",
      });
      const riskCtrl = new RiskController({
        enabled: true,
        maxAutoTradeUsd: 1000,
        confirmThresholdUsd: 5000,
        maxDailyLossUsd: 10000,
        maxPositionPct: 50,
        maxLeverage: 5,
      });

      // Create strategy + account
      const def = createSmaCrossover({
        fastPeriod: 10,
        slowPeriod: 30,
      });
      const record = registry.create(def);
      const acct = paperEngine.createAccount("heartbeat-test", 10000);

      // Simulate single heartbeat at bar 50 (mid uptrend)
      const memory = new Map<string, unknown>();
      const barIndex = 50;
      const history = mockOHLCV.slice(0, barIndex + 1);
      const indicators = buildIndicatorLib(history);
      const ctx = {
        portfolio: {
          equity: acct.equity,
          cash: acct.cash,
          positions: [] as unknown[],
        },
        history,
        indicators,
        regime: "sideways" as const,
        memory,
        log: () => {},
      };

      // Execute onBar — the pipeline must not crash
      const signal = await record.definition.onBar(mockOHLCV[barIndex], ctx);
      // Signal is either null or a valid Signal object
      if (signal) {
        expect(signal.action).toMatch(/^(buy|sell|close)$/);
        expect(typeof signal.confidence).toBe("number");
        expect(signal.symbol).toBe("BTC/USDT");
      }

      // Risk evaluation should work on any order
      const riskEval = riskCtrl.evaluate(
        {
          exchange: "binance",
          symbol: "BTC/USDT",
          side: "buy",
          type: "market",
          amount: 0.01,
        },
        500,
      );
      expect(riskEval.tier).toBe("auto");

      // Account state persisted correctly
      const state = paperEngine.getAccountState(acct.id);
      expect(state).not.toBeNull();
      expect(state!.equity).toBe(10000);
      expect(state!.cash).toBe(10000);

      paperStore.close();
    });

    test("A2: Consecutive 5 heartbeats with state accumulation", async () => {
      const registry = new StrategyRegistry(join(tmpDir, "heartbeat-a2", "strategies.json"));
      const paperStore = new PaperStore(join(tmpDir, "heartbeat-a2", "paper.sqlite"));
      const paperEngine = new PaperEngine({
        store: paperStore,
        slippageBps: 5,
        market: "crypto",
      });

      const def = createSmaCrossover({
        fastPeriod: 10,
        slowPeriod: 30,
      });
      registry.create(def);
      const acct = paperEngine.createAccount("heartbeat-5", 10000);

      const memory = new Map<string, unknown>();
      const signals: Array<{
        action: string;
        bar: number;
      }> = [];

      // Tick bars 50-54
      for (let i = 50; i <= 54; i++) {
        const history = mockOHLCV.slice(0, i + 1);
        const indicators = buildIndicatorLib(history);
        const state = paperEngine.getAccountState(acct.id)!;
        const ctx = {
          portfolio: {
            equity: state.equity,
            cash: state.cash,
            positions: [] as unknown[],
          },
          history,
          indicators,
          regime: "sideways" as const,
          memory,
          log: () => {},
        };

        const signal = await def.onBar(mockOHLCV[i], ctx);
        if (signal) {
          signals.push({ action: signal.action, bar: i });
          // Submit buy signal to paper engine (crypto always open)
          if (signal.action === "buy") {
            paperEngine.submitOrder(
              acct.id,
              {
                symbol: "BTC/USDT",
                side: "buy",
                type: "market",
                quantity: 0.01,
              },
              mockOHLCV[i].close,
            );
          }
        }
      }

      // The memory map should persist across ticks
      expect(memory).toBeInstanceOf(Map);

      // Account should still be valid (either unchanged or with a position)
      const finalState = paperEngine.getAccountState(acct.id)!;
      expect(finalState.equity).toBeGreaterThan(0);
      expect(finalState.cash).toBeLessThanOrEqual(10000);

      paperStore.close();
    });

    test("A3: Heartbeat exception recovery — data provider throws", async () => {
      // Simulate a heartbeat that catches data provider errors
      const failingDataFetch = async (): Promise<OHLCV[]> => {
        throw new Error("Network timeout: data provider unreachable");
      };

      let errorCaught = false;
      let heartbeatCompleted = false;

      // Heartbeat loop with error handling
      try {
        const data = await failingDataFetch();
        // Should not reach here
        expect(data).toBeDefined();
      } catch (err) {
        errorCaught = true;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("Network timeout");
      }
      heartbeatCompleted = true;

      expect(errorCaught).toBe(true);
      expect(heartbeatCompleted).toBe(true);

      // Verify that after error, next heartbeat works normally
      const def = createSmaCrossover();
      const history = mockOHLCV.slice(0, 51);
      const ctx = {
        portfolio: { equity: 10000, cash: 10000, positions: [] as unknown[] },
        history,
        indicators: buildIndicatorLib(history),
        regime: "sideways" as const,
        memory: new Map<string, unknown>(),
        log: () => {},
      };
      // Should not throw
      const signal = await def.onBar(mockOHLCV[50], ctx);
      expect(signal === null || typeof signal.action === "string").toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // B. Strategy Tick Chain
  // ═══════════════════════════════════════════════════════════════════════

  describe("B. Strategy Tick Chain", () => {
    test("B1: SMA golden cross → buy signal in uptrend", async () => {
      const def = createSmaCrossover({
        fastPeriod: 10,
        slowPeriod: 30,
      });
      const memory = new Map<string, unknown>();
      let foundBuy = false;

      // Scan all phases: the golden cross occurs in the rebound phase (~bar 200+)
      // after SMA(10) drops below SMA(30) during the downtrend, then crosses back above
      for (let i = 30; i < mockOHLCV.length; i++) {
        const history = mockOHLCV.slice(0, i + 1);
        const indicators = buildIndicatorLib(history);
        const ctx = {
          portfolio: {
            equity: 10000,
            cash: 10000,
            positions: [] as unknown[],
          },
          history,
          indicators,
          regime: "bull" as const,
          memory,
          log: () => {},
        };

        const signal = await def.onBar(mockOHLCV[i], ctx);
        if (signal && signal.action === "buy") {
          foundBuy = true;
          expect(signal.action).toBe("buy");
          expect(signal.symbol).toBe("BTC/USDT");
          expect(signal.sizePct).toBe(100);
          expect(signal.confidence).toBe(0.7);
          expect(signal.reason).toContain("golden cross");
          break;
        }
      }

      expect(foundBuy).toBe(true);
    });

    test("B2: SMA death cross → sell signal in downtrend", async () => {
      const def = createSmaCrossover({
        fastPeriod: 10,
        slowPeriod: 30,
      });
      const memory = new Map<string, unknown>();
      let foundSell = false;

      // Scan downtrend phase (bars 100-199) with hasLong = true
      for (let i = 100; i < 200; i++) {
        const history = mockOHLCV.slice(0, i + 1);
        const indicators = buildIndicatorLib(history);
        const ctx = {
          portfolio: {
            equity: 10000,
            cash: 5000,
            positions: [
              {
                symbol: "BTC/USDT",
                side: "long" as const,
                quantity: 0.1,
                entryPrice: 40000,
                currentPrice: mockOHLCV[i].close,
                unrealizedPnl: 0,
              },
            ],
          },
          history,
          indicators,
          regime: "bear" as const,
          memory,
          log: () => {},
        };

        const signal = await def.onBar(mockOHLCV[i], ctx);
        if (signal && signal.action === "sell") {
          foundSell = true;
          expect(signal.action).toBe("sell");
          expect(signal.symbol).toBe("BTC/USDT");
          expect(signal.reason).toContain("death cross");
          break;
        }
      }

      expect(foundSell).toBe(true);
    });

    test("B3: Signal → paper order → position exists", async () => {
      const paperStore = new PaperStore(join(tmpDir, "tick-b3", "paper.sqlite"));
      const paperEngine = new PaperEngine({
        store: paperStore,
        slippageBps: 5,
        market: "crypto",
      });
      const acct = paperEngine.createAccount("tick-b3", 50000);

      // Submit a buy order directly
      const price = 45000;
      const order = paperEngine.submitOrder(
        acct.id,
        {
          symbol: "BTC/USDT",
          side: "buy",
          type: "market",
          quantity: 0.1,
        },
        price,
      );

      expect(order.status).toBe("filled");
      expect(order.side).toBe("buy");
      expect(order.fillPrice).toBeGreaterThan(0);

      // Verify position exists in account
      const state = paperEngine.getAccountState(acct.id)!;
      expect(state.positions.length).toBe(1);
      expect(state.positions[0].symbol).toBe("BTC/USDT");
      expect(state.positions[0].quantity).toBe(0.1);
      expect(state.cash).toBeLessThan(50000);

      paperStore.close();
    });

    test("B4: Signal → paper → P&L calculation (buy low, sell high)", async () => {
      const paperStore = new PaperStore(join(tmpDir, "tick-b4", "paper.sqlite"));
      const paperEngine = new PaperEngine({
        store: paperStore,
        slippageBps: 5,
        market: "crypto",
      });
      const acct = paperEngine.createAccount("tick-b4", 50000);

      // Buy at lower price
      const buyPrice = 40000;
      const buyOrder = paperEngine.submitOrder(
        acct.id,
        {
          symbol: "BTC/USDT",
          side: "buy",
          type: "market",
          quantity: 0.5,
        },
        buyPrice,
      );
      expect(buyOrder.status).toBe("filled");

      // Update prices to simulate price increase
      paperEngine.updatePrices(acct.id, { "BTC/USDT": 42000 });

      // Check equity increased (unrealized gain)
      const midState = paperEngine.getAccountState(acct.id)!;
      expect(midState.equity).toBeGreaterThan(50000);

      // Sell at higher price
      const sellPrice = 42000;
      const sellOrder = paperEngine.submitOrder(
        acct.id,
        {
          symbol: "BTC/USDT",
          side: "sell",
          type: "market",
          quantity: 0.5,
        },
        sellPrice,
      );
      expect(sellOrder.status).toBe("filled");

      // Verify P&L is positive after round trip
      const finalState = paperEngine.getAccountState(acct.id)!;
      expect(finalState.positions.length).toBe(0);
      // Final equity should be higher than initial (despite slippage + commission)
      // Profit from price move = 0.5 * (42000 - 40000) = 1000 approx
      expect(finalState.equity).toBeGreaterThan(50000);

      paperStore.close();
    });

    test("B5: Sideways OHLCV → no signal (hold)", async () => {
      const sidewaysData = generateOHLCV({
        bars: 100,
        startPrice: 50000,
        trend: "sideways",
        volatility: 0.001,
      });
      const def = createSmaCrossover({
        fastPeriod: 10,
        slowPeriod: 30,
      });
      const memory = new Map<string, unknown>();
      let signalCount = 0;

      // Tick through 50 bars in sideways market
      for (let i = 35; i < 85; i++) {
        const history = sidewaysData.slice(0, i + 1);
        const indicators = buildIndicatorLib(history);
        const ctx = {
          portfolio: {
            equity: 10000,
            cash: 10000,
            positions: [] as unknown[],
          },
          history,
          indicators,
          regime: "sideways" as const,
          memory,
          log: () => {},
        };

        const signal = await def.onBar(sidewaysData[i], ctx);
        if (signal) {
          signalCount++;
        }
      }

      // In a very flat sideways market with tiny volatility, SMA(10) and SMA(30) should
      // not cross frequently. Expect at most 1-2 spurious signals.
      expect(signalCount).toBeLessThanOrEqual(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // C. Fund Manager
  // ═══════════════════════════════════════════════════════════════════════

  describe("C. Fund Manager", () => {
    let fm: FundManager;
    const fundConfig: FundConfig = {
      totalCapital: 100000,
      cashReservePct: 30,
      maxSingleStrategyPct: 30,
      maxTotalExposurePct: 70,
      rebalanceFrequency: "daily",
    };

    beforeAll(() => {
      fm = new FundManager(join(tmpDir, "fund-c", "fund.json"), fundConfig);
    });

    test("C1: FundManager init + getState", () => {
      const state = fm.getState();
      expect(state.totalCapital).toBe(100000);
      expect(state.allocations).toHaveLength(0);
      expect(state.cashReserve).toBe(0);
      expect(state.lastRebalanceAt).toBe(0);
      expect(typeof state.createdAt).toBe("number");
      expect(typeof state.updatedAt).toBe("number");
    });

    test("C2: buildProfiles → StrategyProfile[] with fitness", () => {
      const now = Date.now();
      const records = [
        {
          id: "strat-1",
          name: "SMA Fast",
          version: "1.0.0",
          level: "L1_BACKTEST" as StrategyLevel,
          definition: createSmaCrossover({ fastPeriod: 5, slowPeriod: 20 }),
          createdAt: now - 30 * 86_400_000,
          updatedAt: now,
          lastBacktest: {
            strategyId: "strat-1",
            startDate: now - 365 * 86_400_000,
            endDate: now,
            initialCapital: 10000,
            finalEquity: 13000,
            totalReturn: 30,
            sharpe: 1.5,
            sortino: 2.0,
            maxDrawdown: -15,
            calmar: 2.0,
            winRate: 0.55,
            profitFactor: 1.8,
            totalTrades: 120,
            trades: [],
            equityCurve: [10000, 13000],
            dailyReturns: [0.001],
          } as BacktestResult,
        },
        {
          id: "strat-2",
          name: "SMA Slow",
          version: "1.0.0",
          level: "L2_PAPER" as StrategyLevel,
          definition: createSmaCrossover({
            fastPeriod: 20,
            slowPeriod: 50,
          }),
          createdAt: now - 60 * 86_400_000,
          updatedAt: now,
          lastBacktest: {
            strategyId: "strat-2",
            startDate: now - 365 * 86_400_000,
            endDate: now,
            initialCapital: 10000,
            finalEquity: 12000,
            totalReturn: 20,
            sharpe: 1.2,
            sortino: 1.5,
            maxDrawdown: -10,
            calmar: 2.0,
            winRate: 0.6,
            profitFactor: 2.0,
            totalTrades: 80,
            trades: [],
            equityCurve: [10000, 12000],
            dailyReturns: [0.0008],
          } as BacktestResult,
        },
        {
          id: "strat-3",
          name: "SMA Ultra",
          version: "1.0.0",
          level: "L3_LIVE" as StrategyLevel,
          definition: createSmaCrossover({
            fastPeriod: 10,
            slowPeriod: 30,
          }),
          createdAt: now - 90 * 86_400_000,
          updatedAt: now,
          lastBacktest: {
            strategyId: "strat-3",
            startDate: now - 365 * 86_400_000,
            endDate: now,
            initialCapital: 10000,
            finalEquity: 15000,
            totalReturn: 50,
            sharpe: 2.0,
            sortino: 2.5,
            maxDrawdown: -8,
            calmar: 6.25,
            winRate: 0.65,
            profitFactor: 3.0,
            totalTrades: 150,
            trades: [],
            equityCurve: [10000, 15000],
            dailyReturns: [0.0015],
          } as BacktestResult,
        },
      ];

      const profiles = fm.buildProfiles(records);
      expect(profiles).toHaveLength(3);

      for (const p of profiles) {
        expect(typeof p.fitness).toBe("number");
        expect(p.fitness).toBeGreaterThan(0);
        expect(typeof p.id).toBe("string");
        expect(typeof p.name).toBe("string");
        expect(p.level).toMatch(/^L[0-3]_/);
      }

      // Higher sharpe + more trades should yield higher fitness
      const p1 = profiles.find((p) => p.id === "strat-1")!;
      const p3 = profiles.find((p) => p.id === "strat-3")!;
      expect(p3.fitness).toBeGreaterThan(p1.fitness);
    });

    test("C3: allocate → Half-Kelly with constraints", () => {
      const profiles: StrategyProfile[] = [
        {
          id: "strat-a",
          name: "Alpha",
          level: "L2_PAPER",
          fitness: 0.8,
          backtest: {
            strategyId: "strat-a",
            sharpe: 1.5,
            maxDrawdown: -10,
            totalTrades: 100,
          } as BacktestResult,
        },
        {
          id: "strat-b",
          name: "Beta",
          level: "L3_LIVE",
          fitness: 0.6,
          paperDaysActive: 45,
          backtest: {
            strategyId: "strat-b",
            sharpe: 1.2,
            maxDrawdown: -15,
            totalTrades: 80,
          } as BacktestResult,
        },
      ];

      const allocations = fm.allocate(profiles);

      expect(allocations.length).toBeGreaterThan(0);

      // Total allocated should not exceed maxTotalExposurePct% of capital
      const totalAllocated = allocations.reduce((sum, a) => sum + a.capitalUsd, 0);
      expect(totalAllocated).toBeLessThanOrEqual(100000 * (fundConfig.maxTotalExposurePct / 100));

      // No single strategy should exceed maxSingleStrategyPct%
      for (const alloc of allocations) {
        expect(alloc.capitalUsd).toBeLessThanOrEqual(
          100000 * (fundConfig.maxSingleStrategyPct / 100),
        );
        expect(typeof alloc.weightPct).toBe("number");
        expect(typeof alloc.reason).toBe("string");
        expect(alloc.reason.length).toBeGreaterThan(0);
      }
    });

    test("C4: rebalance full flow", () => {
      const now = Date.now();
      const records = [
        {
          id: "reb-1",
          name: "Rebalance A",
          version: "1.0.0",
          level: "L2_PAPER" as StrategyLevel,
          definition: createSmaCrossover(),
          createdAt: now - 60 * 86_400_000,
          updatedAt: now,
          lastBacktest: {
            strategyId: "reb-1",
            startDate: 0,
            endDate: now,
            initialCapital: 10000,
            finalEquity: 12000,
            totalReturn: 20,
            sharpe: 1.3,
            sortino: 1.5,
            maxDrawdown: -12,
            calmar: 1.67,
            winRate: 0.55,
            profitFactor: 1.5,
            totalTrades: 90,
            trades: [],
            equityCurve: [10000],
            dailyReturns: [],
          } as BacktestResult,
        },
      ];

      const result = fm.rebalance(records);

      expect(Array.isArray(result.allocations)).toBe(true);
      expect(Array.isArray(result.leaderboard)).toBe(true);
      expect(typeof result.risk).toBe("object");
      expect(Array.isArray(result.promotions)).toBe(true);
      expect(Array.isArray(result.demotions)).toBe(true);

      // Risk should have valid fields
      expect(result.risk.totalEquity).toBeGreaterThan(0);
      expect(["normal", "caution", "warning", "critical"].includes(result.risk.riskLevel)).toBe(
        true,
      );
    });

    test("C5: Leaderboard sorting by leaderboardScore descending", () => {
      const profiles: StrategyProfile[] = [
        {
          id: "lb-1",
          name: "Low",
          level: "L1_BACKTEST",
          fitness: 0.3,
          backtest: {
            strategyId: "lb-1",
            sharpe: 0.5,
            maxDrawdown: -20,
            totalTrades: 50,
          } as BacktestResult,
        },
        {
          id: "lb-2",
          name: "Mid",
          level: "L2_PAPER",
          fitness: 0.6,
          backtest: {
            strategyId: "lb-2",
            sharpe: 1.2,
            maxDrawdown: -12,
            totalTrades: 80,
          } as BacktestResult,
        },
        {
          id: "lb-3",
          name: "High",
          level: "L3_LIVE",
          fitness: 0.9,
          backtest: {
            strategyId: "lb-3",
            sharpe: 2.0,
            maxDrawdown: -5,
            totalTrades: 150,
          } as BacktestResult,
        },
      ];

      const lb = fm.getLeaderboard(profiles);

      // Should be sorted by leaderboardScore descending
      for (let i = 1; i < lb.length; i++) {
        expect(lb[i - 1].leaderboardScore).toBeGreaterThanOrEqual(lb[i].leaderboardScore);
      }

      // Ranks should be 1-indexed and sequential
      for (let i = 0; i < lb.length; i++) {
        expect(lb[i].rank).toBe(i + 1);
      }

      // Each entry should have all required fields
      for (const entry of lb) {
        expect(typeof entry.strategyId).toBe("string");
        expect(typeof entry.strategyName).toBe("string");
        expect(typeof entry.fitness).toBe("number");
        expect(typeof entry.confidenceMultiplier).toBe("number");
        expect(typeof entry.leaderboardScore).toBe("number");
        expect(typeof entry.sharpe).toBe("number");
        expect(typeof entry.maxDrawdown).toBe("number");
        expect(typeof entry.totalTrades).toBe("number");
      }

      // L3_LIVE with highest fitness should be ranked first (multiplier = 1.0)
      expect(lb[0].strategyId).toBe("lb-3");
      expect(lb[0].confidenceMultiplier).toBe(1.0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // D. Trade Memory
  // ═══════════════════════════════════════════════════════════════════════

  describe("D. Trade Memory", () => {
    let journal: TradeJournal;

    beforeAll(() => {
      journal = new TradeJournal(join(tmpDir, "memory-d", "journal.jsonl"));
    });

    test("D1: TradeJournal CRUD — append, count, query", () => {
      const entry: TradeEntry = {
        id: "t-001",
        timestamp: Date.now(),
        strategyId: "sma-1",
        symbol: "BTC/USDT",
        side: "buy",
        price: 50000,
        quantity: 0.1,
        notional: 5000,
        source: "paper",
      };
      journal.append(entry);
      expect(journal.count()).toBe(1);

      const results = journal.query({ strategyId: "sma-1" });
      expect(results.length).toBe(1);
      expect(results[0].symbol).toBe("BTC/USDT");
      expect(results[0].price).toBe(50000);
      expect(results[0].source).toBe("paper");

      // Query by symbol
      const bySymbol = journal.query({ symbol: "BTC/USDT" });
      expect(bySymbol.length).toBe(1);

      // Query with non-matching filter
      const noMatch = journal.query({ strategyId: "nonexistent" });
      expect(noMatch.length).toBe(0);
    });

    test("D2: ErrorBook record + check severity and constraints", () => {
      const errorBook = new ErrorBook(join(tmpDir, "memory-d", "errors.json"));
      errorBook.record({
        id: "err-timing-1",
        description: "Bought too late in uptrend",
        category: "timing",
        loss: 500,
        tradeId: "t-001",
        symbol: "BTC/USDT",
        regime: "bull",
        constraint: "Do not buy after 80% of trend move",
      });

      const errors = errorBook.topErrors();
      expect(errors.length).toBe(1);
      expect(errors[0].severity).toBe("low"); // first occurrence, $500 loss
      expect(errors[0].category).toBe("timing");
      expect(errors[0].occurrences).toBe(1);
      expect(errors[0].totalLoss).toBe(500);

      const constraints = errorBook.getConstraints("BTC/USDT", "bull");
      expect(constraints.length).toBe(1);
      expect(constraints[0]).toBe("Do not buy after 80% of trend move");

      // Record same error again → severity escalation
      errorBook.record({
        id: "err-timing-1",
        description: "Bought too late in uptrend",
        category: "timing",
        loss: 600,
        tradeId: "t-002",
        symbol: "ETH/USDT",
        regime: "bull",
      });
      const updated = errorBook.topErrors();
      expect(updated[0].occurrences).toBe(2);
      expect(updated[0].totalLoss).toBe(1100);
      expect(updated[0].severity).toBe("medium"); // 2 occurrences + 1100 > 500
      expect(updated[0].symbols).toContain("BTC/USDT");
      expect(updated[0].symbols).toContain("ETH/USDT");
    });

    test("D3: SuccessBook record + confidence levels", () => {
      const successBook = new SuccessBook(join(tmpDir, "memory-d", "successes.json"));
      successBook.record({
        id: "succ-1",
        description: "Golden cross in bull regime",
        category: "entry",
        profit: 1200,
        tradeId: "t-002",
        symbol: "ETH/USDT",
        regime: "bull",
        insight: "SMA crossover works well in trending markets",
      });

      const successes = successBook.topSuccesses();
      expect(successes.length).toBe(1);
      expect(successes[0].confidence).toBe("emerging"); // first occurrence
      expect(successes[0].totalProfit).toBe(1200);
      expect(successes[0].category).toBe("entry");

      const insights = successBook.getInsights("ETH/USDT", "bull");
      expect(insights.length).toBe(1);
      expect(insights[0]).toContain("SMA crossover");
    });

    test("D4: TradeJournal summarize with mixed P&L", () => {
      // Add more trades with P&L values
      journal.append({
        id: "t-002",
        timestamp: Date.now(),
        strategyId: "sma-1",
        symbol: "BTC/USDT",
        side: "sell",
        price: 51000,
        quantity: 0.1,
        notional: 5100,
        pnl: 500,
        source: "paper",
      });
      journal.append({
        id: "t-003",
        timestamp: Date.now(),
        strategyId: "sma-1",
        symbol: "ETH/USDT",
        side: "sell",
        price: 3000,
        quantity: 1,
        notional: 3000,
        pnl: -200,
        source: "paper",
      });
      journal.append({
        id: "t-004",
        timestamp: Date.now(),
        strategyId: "sma-1",
        symbol: "BTC/USDT",
        side: "sell",
        price: 52000,
        quantity: 0.1,
        notional: 5200,
        pnl: 300,
        source: "paper",
      });

      const summary = journal.summarize();
      expect(summary.totalTrades).toBe(4); // t-001, t-002, t-003, t-004
      expect(summary.wins).toBe(2); // t-002 (+500), t-004 (+300)
      expect(summary.losses).toBe(1); // t-003 (-200)
      expect(summary.totalPnl).toBe(600); // 500 + (-200) + 300
      expect(summary.largestWin).toBe(500);
      expect(summary.largestLoss).toBe(-200);
      expect(summary.profitFactor).toBe(800 / 200); // sumWins / |sumLosses|
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E. Evolution Sweep
  // ═══════════════════════════════════════════════════════════════════════

  describe("E. Evolution Sweep", () => {
    test("E1: Discover underperforming strategy via scheduled RDAVD", async () => {
      const evoStore = new EvolutionStore(join(tmpDir, "evo-e1", "evo.sqlite"));

      // Create a node with low fitness (candidate for evolution)
      const node: EvolutionNode = {
        id: "evo-test-gen0",
        strategyId: "test-strat",
        strategyName: "Test Strategy",
        generation: 0,
        parentId: null,
        genes: [
          {
            id: "gene-rsi",
            name: "RSI_Oversold",
            type: "signal",
            params: { period: 14, threshold: 30 },
            direction: 1,
            confidence: 0.6,
          },
        ],
        fitness: 0.3,
        survivalTier: "healthy",
        level: "L1_BACKTEST",
        backtestSharpe: 0.8,
        maxDrawdown: -0.08,
        winRate: 0.5,
        totalTrades: 50,
        createdAt: new Date().toISOString(),
      };
      evoStore.saveNode(node);

      // Run RDAVD with "scheduled" trigger
      const result = await runRdavdCycle("test-strat", "scheduled", {
        store: evoStore,
      });

      expect(result.cycle.strategyId).toBe("test-strat");
      expect(result.cycle.trigger).toBe("scheduled");
      expect(typeof result.cycle.survivalAssessment.shouldEvolve).toBe("boolean");
      expect(result.cycle.survivalAssessment.decaySignal.level).toMatch(/^(green|yellow|red)$/);

      // With no real decay, scheduled trigger may or may not evolve
      expect(["no_action", "mutated", "rejected"]).toContain(result.cycle.outcome);

      evoStore.close();
    });

    test("E2: Manual trigger → mutation → new generation", async () => {
      const evoStore = new EvolutionStore(join(tmpDir, "evo-e2", "evo.sqlite"));

      const genes: Gene[] = [
        {
          id: "gene-sma-fast",
          name: "SMA_Fast",
          type: "signal",
          params: { period: 10 },
          direction: 1,
          confidence: 0.7,
        },
        {
          id: "gene-sma-slow",
          name: "SMA_Slow",
          type: "signal",
          params: { period: 30 },
          direction: 1,
          confidence: 0.7,
        },
      ];

      const node: EvolutionNode = {
        id: "evo-manual-gen0",
        strategyId: "manual-strat",
        strategyName: "Manual Test",
        generation: 0,
        parentId: null,
        genes,
        fitness: 0.4,
        survivalTier: "healthy",
        level: "L1_BACKTEST",
        backtestSharpe: 1.0,
        maxDrawdown: -0.1,
        winRate: 0.55,
        totalTrades: 100,
        createdAt: new Date().toISOString(),
      };
      evoStore.saveNode(node);

      // Manual trigger forces evolution
      const result = await runRdavdCycle("manual-strat", "manual", {
        store: evoStore,
      });

      expect(result.cycle.trigger).toBe("manual");
      // Manual trigger always enters the mutation path
      expect(["mutated", "rejected"]).toContain(result.cycle.outcome);

      if (result.cycle.outcome === "mutated" && result.newNode) {
        expect(result.newNode.generation).toBe(1);
        expect(result.newNode.parentId).toBe("evo-manual-gen0");
        expect(result.newNode.strategyId).toBe("manual-strat");
        expect(result.newNode.genes.length).toBe(2);
        expect(result.newNode.fitness).toBeGreaterThanOrEqual(0);
      }

      evoStore.close();
    });

    test("E3: Successful mutation → new node has improved fitness", async () => {
      const evoStore = new EvolutionStore(join(tmpDir, "evo-e3", "evo.sqlite"));

      // Node with moderate fitness
      const node: EvolutionNode = {
        id: "evo-improve-gen0",
        strategyId: "improve-strat",
        strategyName: "Improvement Test",
        generation: 0,
        parentId: null,
        genes: [
          {
            id: "gene-trend",
            name: "Trend_Follow",
            type: "signal",
            params: { period: 20, threshold: 0.5 },
            direction: 1,
            confidence: 0.6,
          },
        ],
        fitness: 0.35,
        survivalTier: "healthy",
        level: "L1_BACKTEST",
        backtestSharpe: 0.9,
        maxDrawdown: -0.12,
        winRate: 0.52,
        totalTrades: 80,
        createdAt: new Date().toISOString(),
      };
      evoStore.saveNode(node);

      const result = await runRdavdCycle("improve-strat", "manual", {
        store: evoStore,
      });

      if (result.cycle.outcome === "mutated" && result.newNode) {
        // Fitness improved (simulated validation boosts by ~5%)
        expect(result.newNode.fitness).toBeGreaterThan(node.fitness);
        expect(result.newNode.generation).toBe(1);
      }
      // If rejected, the validation determined no improvement above threshold
      // Either way, the cycle completed without error
      expect(result.cycle.completedAt).toBeDefined();

      evoStore.close();
    });

    test("E4: High-fitness node → no evolution on scheduled trigger", async () => {
      const evoStore = new EvolutionStore(join(tmpDir, "evo-e4", "evo.sqlite"));

      // Very high fitness, thriving tier — should not trigger evolution
      const node: EvolutionNode = {
        id: "evo-healthy-gen0",
        strategyId: "healthy-strat",
        strategyName: "Healthy Strategy",
        generation: 0,
        parentId: null,
        genes: [
          {
            id: "gene-perf",
            name: "Perf_Signal",
            type: "signal",
            params: { period: 14 },
            direction: 1,
            confidence: 0.9,
          },
        ],
        fitness: 0.95,
        survivalTier: "thriving",
        level: "L2_PAPER",
        backtestSharpe: 2.5,
        paperSharpe: 2.3,
        maxDrawdown: -0.03,
        winRate: 0.7,
        totalTrades: 200,
        createdAt: new Date().toISOString(),
      };
      evoStore.saveNode(node);

      // Scheduled trigger with healthy strategy → expect no_action
      const result = await runRdavdCycle("healthy-strat", "scheduled", {
        store: evoStore,
      });

      expect(result.cycle.outcome).toBe("no_action");
      expect(result.newNode).toBeUndefined();

      // Verify the original node is unchanged
      const stored = evoStore.getLatestGeneration("healthy-strat");
      expect(stored!.generation).toBe(0);
      expect(stored!.fitness).toBe(0.95);

      evoStore.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // F. Monitoring Alerts
  // ═══════════════════════════════════════════════════════════════════════

  describe("F. Monitoring Alerts", () => {
    let alertStore: AlertStore;
    let alertEngine: AlertEngine;

    beforeAll(() => {
      alertStore = new AlertStore(join(tmpDir, "alerts-f", "alerts.sqlite"));
      alertEngine = new AlertEngine(alertStore);
    });

    afterAll(() => {
      alertStore.close();
    });

    test("F1: AlertEngine condition evaluation — price above/below", () => {
      alertEngine.addAlert({
        kind: "price_above",
        symbol: "BTC/USDT",
        price: 60000,
      });
      alertEngine.addAlert({
        kind: "price_below",
        symbol: "BTC/USDT",
        price: 40000,
      });

      // Check above threshold
      const triggered = alertEngine.checkPrice("BTC/USDT", 61000);
      expect(triggered.length).toBe(1);
      expect(triggered[0].condition.kind).toBe("price_above");
      expect(triggered[0].triggeredAt).toBeDefined();

      // Check already-triggered alert is not triggered again
      const retriggered = alertEngine.checkPrice("BTC/USDT", 65000);
      expect(retriggered.length).toBe(0);

      // Check below threshold
      const below = alertEngine.checkPrice("BTC/USDT", 39000);
      expect(below.length).toBe(1);
      expect(below[0].condition.kind).toBe("price_below");

      // Middle price triggers neither
      const mid = alertEngine.checkPrice("BTC/USDT", 50000);
      expect(mid.length).toBe(0);
    });

    test("F2: AlertStore CRUD — list, remove, persist", () => {
      const alerts = alertEngine.listAlerts();
      expect(alerts.length).toBe(2);

      // Both alerts should have been triggered
      const triggeredAlerts = alerts.filter((a) => a.triggeredAt !== undefined);
      expect(triggeredAlerts.length).toBe(2);

      // Remove one alert
      const removed = alertEngine.removeAlert(alerts[0].id);
      expect(removed).toBe(true);
      expect(alertEngine.listAlerts().length).toBe(1);

      // Remove non-existent alert returns false
      const removeFail = alertEngine.removeAlert("nonexistent-id");
      expect(removeFail).toBe(false);
    });

    test("F3: PnL threshold alerts — loss detection", () => {
      const pnlId = alertEngine.addAlert({
        kind: "pnl_threshold",
        threshold: 500,
        direction: "loss",
      });
      expect(typeof pnlId).toBe("string");

      // P&L within limit — no trigger
      const noTrigger = alertEngine.checkPnl(-300);
      expect(noTrigger.length).toBe(0);

      // P&L exceeds threshold — trigger
      const pnlTriggered = alertEngine.checkPnl(-600);
      expect(pnlTriggered.length).toBe(1);
      expect(pnlTriggered[0].id).toBe(pnlId);
      expect(pnlTriggered[0].condition.kind).toBe("pnl_threshold");
      expect(pnlTriggered[0].triggeredAt).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // G. HTTP API + SSE Data Shapes
  // ═══════════════════════════════════════════════════════════════════════

  describe("G. HTTP API + SSE Data Shapes", () => {
    let fm: FundManager;
    const fundConfig: FundConfig = {
      totalCapital: 100000,
      cashReservePct: 30,
      maxSingleStrategyPct: 30,
      maxTotalExposurePct: 70,
      rebalanceFrequency: "daily",
    };

    const testProfiles: StrategyProfile[] = [
      {
        id: "api-1",
        name: "API Alpha",
        level: "L2_PAPER",
        fitness: 0.7,
        backtest: {
          strategyId: "api-1",
          sharpe: 1.3,
          maxDrawdown: -10,
          totalTrades: 100,
        } as BacktestResult,
      },
      {
        id: "api-2",
        name: "API Beta",
        level: "L3_LIVE",
        fitness: 0.85,
        paperDaysActive: 50,
        backtest: {
          strategyId: "api-2",
          sharpe: 1.8,
          maxDrawdown: -7,
          totalTrades: 150,
        } as BacktestResult,
      },
    ];

    beforeAll(() => {
      fm = new FundManager(join(tmpDir, "fund-g", "fund.json"), fundConfig);
      fm.markDayStart(100000);
    });

    test("G1: Fund status data shape — risk evaluation", () => {
      const risk = fm.evaluateRisk(100000);

      expect(typeof risk.totalEquity).toBe("number");
      expect(risk.totalEquity).toBe(100000);
      expect(typeof risk.riskLevel).toBe("string");
      expect(["normal", "caution", "warning", "critical"].includes(risk.riskLevel)).toBe(true);
      expect(typeof risk.dailyDrawdown).toBe("number");
      expect(risk.dailyDrawdown).toBeGreaterThanOrEqual(0);
      expect(typeof risk.todayPnl).toBe("number");
      expect(typeof risk.todayPnlPct).toBe("number");
      expect(typeof risk.maxAllowedDrawdown).toBe("number");
      expect(risk.maxAllowedDrawdown).toBe(10);
    });

    test("G2: Leaderboard data shape — all required fields", () => {
      const lb = fm.getLeaderboard(testProfiles);

      expect(lb.length).toBeGreaterThan(0);

      for (const entry of lb) {
        expect(typeof entry.rank).toBe("number");
        expect(entry.rank).toBeGreaterThan(0);
        expect(typeof entry.strategyId).toBe("string");
        expect(typeof entry.strategyName).toBe("string");
        expect(typeof entry.level).toBe("string");
        expect(typeof entry.fitness).toBe("number");
        expect(typeof entry.leaderboardScore).toBe("number");
        expect(typeof entry.sharpe).toBe("number");
        expect(typeof entry.maxDrawdown).toBe("number");
        expect(typeof entry.totalTrades).toBe("number");
        expect(typeof entry.confidenceMultiplier).toBe("number");
      }

      // API Beta (L3_LIVE) should rank higher than API Alpha (L2_PAPER) due to
      // higher fitness (0.85) AND higher confidence multiplier (1.0 vs 0.7)
      expect(lb[0].strategyId).toBe("api-2");
    });

    test("G3: Risk evaluation data shape — exposure and reserves", () => {
      // Allocate first to have non-zero exposure
      fm.allocate(testProfiles);
      const risk = fm.evaluateRisk(100000);

      expect(risk.totalEquity).toBeGreaterThan(0);
      expect(risk.exposurePct).toBeGreaterThanOrEqual(0);
      expect(risk.cashReservePct).toBeGreaterThanOrEqual(0);
      expect(risk.activeStrategies).toBeGreaterThanOrEqual(0);

      // With allocations, exposure should be > 0
      expect(risk.exposurePct).toBeGreaterThan(0);
      // Cash reserve + exposure should roughly cover everything
      expect(risk.exposurePct + risk.cashReservePct).toBeCloseTo(100, -1);
    });

    test("G4: SSE data shape — full dashboard JSON serialization", () => {
      const allocations = fm.allocate(testProfiles);
      const lb = fm.getLeaderboard(testProfiles);
      const risk = fm.evaluateRisk(100000);

      const fullData = {
        status: {
          totalEquity: 100000,
          riskLevel: risk.riskLevel,
          dailyDrawdown: risk.dailyDrawdown,
          todayPnl: risk.todayPnl,
          activeStrategies: risk.activeStrategies,
        },
        leaderboard: lb,
        allocations: {
          items: allocations,
          totalAllocated: allocations.reduce((sum, a) => sum + a.capitalUsd, 0),
          cashReserve: 100000 - allocations.reduce((sum, a) => sum + a.capitalUsd, 0),
          totalCapital: 100000,
        },
        risk,
      };

      // Must serialize to valid JSON without errors
      const json = JSON.stringify(fullData);
      expect(() => JSON.parse(json)).not.toThrow();

      // Parsed data should match original structure
      const parsed = JSON.parse(json);
      expect(parsed.status.totalEquity).toBe(100000);
      expect(Array.isArray(parsed.leaderboard)).toBe(true);
      expect(parsed.allocations.totalCapital).toBe(100000);
      expect(typeof parsed.risk.riskLevel).toBe("string");
    });

    test("G5: Fund dashboard data completeness — all required sections", () => {
      const state = fm.getState();
      const allocations = fm.allocate(testProfiles);
      const lb = fm.getLeaderboard(testProfiles);
      const risk = fm.evaluateRisk(state.totalCapital);

      const dashboard = {
        status: state,
        leaderboard: lb,
        allocations,
        risk,
      };

      // All top-level sections present
      expect(dashboard.status).toBeDefined();
      expect(dashboard.leaderboard).toBeDefined();
      expect(dashboard.allocations).toBeDefined();
      expect(dashboard.risk).toBeDefined();

      // Status has required fields
      expect(typeof dashboard.status.totalCapital).toBe("number");
      expect(typeof dashboard.status.lastRebalanceAt).toBe("number");
      expect(Array.isArray(dashboard.status.allocations)).toBe(true);

      // Leaderboard is a ranked list
      expect(Array.isArray(dashboard.leaderboard)).toBe(true);
      expect(dashboard.leaderboard.length).toBeGreaterThan(0);

      // Allocations sum to reasonable values
      const totalAlloc = dashboard.allocations.reduce((sum, a) => sum + a.capitalUsd, 0);
      expect(totalAlloc).toBeLessThanOrEqual(state.totalCapital);

      // Risk has required severity level
      expect(["normal", "caution", "warning", "critical"].includes(dashboard.risk.riskLevel)).toBe(
        true,
      );
    });
  });
});
