/**
 * L2 Integration — Strategy Lifecycle
 *
 * Tests the complete strategy promotion/demotion pipeline using real
 * StrategyRegistry, FundManager, PromotionPipeline, and PaperEngine.
 * Only external services (backtest bridge network calls) are mocked.
 */

vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FundManager } from "../../../extensions/findoo-trader-plugin/src/fund/fund-manager.js";
import { PromotionPipeline } from "../../../extensions/findoo-trader-plugin/src/fund/promotion-pipeline.js";
import type { FundConfig } from "../../../extensions/findoo-trader-plugin/src/fund/types.js";
import * as marketCalendar from "../../../extensions/findoo-trader-plugin/src/paper/market-rules/market-calendar.js";
import { PaperEngine } from "../../../extensions/findoo-trader-plugin/src/paper/paper-engine.js";
import { PaperStore } from "../../../extensions/findoo-trader-plugin/src/paper/paper-store.js";
import type {
  BacktestResult,
  WalkForwardResult,
  StrategyRecord,
  DecayState,
} from "../../../extensions/findoo-trader-plugin/src/shared/types.js";
import { createSmaCrossover } from "../../../extensions/findoo-trader-plugin/src/strategy/builtin-strategies/sma-crossover.js";
import { StrategyRegistry } from "../../../extensions/findoo-trader-plugin/src/strategy/strategy-registry.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let registry: StrategyRegistry;
let paperStore: PaperStore;
let paperEngine: PaperEngine;
let _fundManager: FundManager;
let pipeline: PromotionPipeline;

const fundConfig: FundConfig = {
  totalCapital: 100_000,
  cashReservePct: 20,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "daily",
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l2-lifecycle-"));
  registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
  paperStore = new PaperStore(join(tmpDir, "paper.db"));
  paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
  _fundManager = new FundManager(join(tmpDir, "fund.json"), fundConfig);
  pipeline = new PromotionPipeline();

  vi.spyOn(marketCalendar, "isMarketOpen").mockReturnValue(true);
  vi.spyOn(marketCalendar, "resolveMarket").mockReturnValue("crypto");
});

afterEach(() => {
  paperStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStrategy(name: string, id?: string): StrategyRecord {
  const def = createSmaCrossover({ fastPeriod: 5, slowPeriod: 20 });
  def.id = id ?? `sma-${Date.now()}`;
  def.name = name;
  return registry.create(def);
}

function makeBacktestResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    strategyId: "test",
    startDate: Date.now() - 86_400_000 * 365,
    endDate: Date.now(),
    initialCapital: 10_000,
    finalEquity: 15_000,
    totalReturn: 50,
    sharpe: 1.5,
    sortino: 1.8,
    maxDrawdown: -15,
    calmar: 3.3,
    winRate: 0.55,
    profitFactor: 1.8,
    totalTrades: 150,
    trades: [],
    equityCurve: [10_000, 11_000, 12_000, 15_000],
    dailyReturns: [0.01, -0.005, 0.02],
    ...overrides,
  };
}

function makeWalkForwardResult(passed: boolean): WalkForwardResult {
  return {
    passed,
    windows: [
      {
        trainStart: 0,
        trainEnd: 100,
        testStart: 100,
        testEnd: 150,
        trainSharpe: 1.5,
        testSharpe: 1.2,
      },
      {
        trainStart: 50,
        trainEnd: 150,
        testStart: 150,
        testEnd: 200,
        trainSharpe: 1.4,
        testSharpe: 1.1,
      },
      {
        trainStart: 100,
        trainEnd: 200,
        testStart: 200,
        testEnd: 250,
        trainSharpe: 1.6,
        testSharpe: 1.0,
      },
    ],
    combinedTestSharpe: passed ? 1.1 : 0.3,
    avgTrainSharpe: 1.5,
    ratio: passed ? 0.73 : 0.2,
    threshold: 0.6,
  };
}

function makeDecayState(overrides: Partial<DecayState> = {}): DecayState {
  return {
    rollingSharpe7d: 1.2,
    rollingSharpe30d: 1.8,
    sharpeMomentum: 0.1,
    consecutiveLossDays: 0,
    currentDrawdown: -5,
    peakEquity: 12_000,
    decayLevel: "healthy",
    ...overrides,
  };
}

function buildProfile(
  record: StrategyRecord,
  overrides: Partial<StrategyProfile> = {},
): StrategyProfile {
  return {
    id: record.id,
    name: record.name,
    level: record.level,
    backtest: record.lastBacktest,
    walkForward: record.lastWalkForward,
    fitness: 0.5,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("Strategy Lifecycle — L0 through KILLED", () => {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. New strategy starts at L0
  // ═══════════════════════════════════════════════════════════════════════

  it("newly created strategy enters L0_INCUBATE", () => {
    const record = createStrategy("Fresh SMA");
    expect(record.level).toBe("L0_INCUBATE");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. L0 → L1 auto-promotion (always eligible)
  // ═══════════════════════════════════════════════════════════════════════

  it("L0 strategy auto-promotes to L1_BACKTEST", () => {
    const record = createStrategy("L0 Candidate", "sma-l0-1");
    const profile = buildProfile(record);

    const check = pipeline.checkPromotion(profile);
    expect(check.eligible).toBe(true);
    expect(check.targetLevel).toBe("L1_BACKTEST");

    registry.updateLevel(record.id, "L1_BACKTEST");
    expect(registry.get(record.id)!.level).toBe("L1_BACKTEST");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. L1 with good backtest + walk-forward → eligible for L2
  // ═══════════════════════════════════════════════════════════════════════

  it("L1 with Sharpe>=1.0, DD<=25%, trades>=100, WF passed → eligible for L2", () => {
    const record = createStrategy("L1 Good", "sma-l1-good");
    registry.updateLevel(record.id, "L1_BACKTEST");
    registry.updateBacktest(
      record.id,
      makeBacktestResult({ sharpe: 1.5, maxDrawdown: -15, totalTrades: 150 }),
    );
    registry.updateWalkForward(record.id, makeWalkForwardResult(true));

    const updated = registry.get(record.id)!;
    const profile = buildProfile(updated);

    const check = pipeline.checkPromotion(profile);
    expect(check.eligible).toBe(true);
    expect(check.targetLevel).toBe("L2_PAPER");
    expect(check.blockers).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. L1 with bad Sharpe → blocked
  // ═══════════════════════════════════════════════════════════════════════

  it("L1 with Sharpe < 1.0 is blocked from L2 promotion", () => {
    const record = createStrategy("Low Sharpe", "sma-l1-low");
    registry.updateLevel(record.id, "L1_BACKTEST");
    registry.updateBacktest(record.id, makeBacktestResult({ sharpe: 0.7, totalTrades: 150 }));
    registry.updateWalkForward(record.id, makeWalkForwardResult(true));

    const updated = registry.get(record.id)!;
    const profile = buildProfile(updated);

    const check = pipeline.checkPromotion(profile);
    expect(check.eligible).toBe(false);
    expect(check.blockers.some((b) => b.includes("Sharpe"))).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. L1 with excessive drawdown → blocked
  // ═══════════════════════════════════════════════════════════════════════

  it("L1 with maxDrawdown > 25% is blocked", () => {
    const record = createStrategy("High DD", "sma-l1-dd");
    registry.updateLevel(record.id, "L1_BACKTEST");
    registry.updateBacktest(
      record.id,
      makeBacktestResult({ sharpe: 1.5, maxDrawdown: -30, totalTrades: 150 }),
    );
    registry.updateWalkForward(record.id, makeWalkForwardResult(true));

    const updated = registry.get(record.id)!;
    const profile = buildProfile(updated);

    const check = pipeline.checkPromotion(profile);
    expect(check.eligible).toBe(false);
    expect(check.blockers.some((b) => b.includes("25%"))).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. L1 with too few trades → blocked
  // ═══════════════════════════════════════════════════════════════════════

  it("L1 with fewer than 100 trades is blocked", () => {
    const record = createStrategy("Few Trades", "sma-l1-few");
    registry.updateLevel(record.id, "L1_BACKTEST");
    registry.updateBacktest(record.id, makeBacktestResult({ sharpe: 1.5, totalTrades: 50 }));
    registry.updateWalkForward(record.id, makeWalkForwardResult(true));

    const updated = registry.get(record.id)!;
    const profile = buildProfile(updated);

    const check = pipeline.checkPromotion(profile);
    expect(check.eligible).toBe(false);
    expect(check.blockers.some((b) => b.includes("100"))).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Walk-Forward fails → blocked
  // ═══════════════════════════════════════════════════════════════════════

  it("failed walk-forward blocks L1→L2 promotion", () => {
    const record = createStrategy("WF Fail", "sma-l1-wf");
    registry.updateLevel(record.id, "L1_BACKTEST");
    registry.updateBacktest(record.id, makeBacktestResult());
    registry.updateWalkForward(record.id, makeWalkForwardResult(false));

    const updated = registry.get(record.id)!;
    const profile = buildProfile(updated);

    const check = pipeline.checkPromotion(profile);
    expect(check.eligible).toBe(false);
    expect(check.blockers.some((b) => b.includes("Walk-forward"))).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. L2 → L3 requires user confirmation
  // ═══════════════════════════════════════════════════════════════════════

  it("L2 eligible for L3 requires user confirmation", () => {
    const record = createStrategy("L2 Ready", "sma-l2-ready");
    registry.updateLevel(record.id, "L2_PAPER");
    registry.updateBacktest(record.id, makeBacktestResult({ sharpe: 2.0 }));

    const updated = registry.get(record.id)!;
    const profile = buildProfile(updated, {
      level: "L2_PAPER",
      paperMetrics: makeDecayState({ rollingSharpe30d: 1.8, currentDrawdown: -10 }),
      paperDaysActive: 45,
      paperTradeCount: 50,
      paperEquity: 12_000,
      paperInitialCapital: 10_000,
    });

    const check = pipeline.checkPromotion(profile);
    expect(check.eligible).toBe(true);
    expect(check.targetLevel).toBe("L3_LIVE");
    expect(check.needsUserConfirmation).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. L2 with insufficient paper days → blocked
  // ═══════════════════════════════════════════════════════════════════════

  it("L2 with fewer than 30 paper days is blocked from L3", () => {
    const record = createStrategy("Too Young", "sma-l2-young");
    registry.updateLevel(record.id, "L2_PAPER");

    const profile = buildProfile(
      { ...registry.get(record.id)!, level: "L2_PAPER" },
      {
        level: "L2_PAPER",
        paperMetrics: makeDecayState({ rollingSharpe30d: 2.0 }),
        paperDaysActive: 15,
        paperTradeCount: 50,
      },
    );

    const check = pipeline.checkPromotion(profile);
    expect(check.eligible).toBe(false);
    expect(check.blockers.some((b) => b.includes("30"))).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. L3 poor performance (Sharpe < 0) → demoted to L2
  // ═══════════════════════════════════════════════════════════════════════

  it("L3 with negative 7d Sharpe is demoted to L2", () => {
    const record = createStrategy("L3 Bad", "sma-l3-bad");
    registry.updateLevel(record.id, "L3_LIVE");

    const profile = buildProfile(
      { ...registry.get(record.id)!, level: "L3_LIVE" },
      {
        level: "L3_LIVE",
        paperMetrics: makeDecayState({
          rollingSharpe7d: -0.5,
          rollingSharpe30d: 0.3,
          decayLevel: "warning",
        }),
      },
    );

    const demotion = pipeline.checkDemotion(profile);
    expect(demotion.shouldDemote).toBe(true);
    expect(demotion.targetLevel).toBe("L2_PAPER");
    expect(demotion.reasons.some((r) => r.includes("7d Sharpe"))).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. L3 consecutive loss days → demoted
  // ═══════════════════════════════════════════════════════════════════════

  it("L3 with 3+ consecutive loss days is demoted", () => {
    const profile: StrategyProfile = {
      id: "sma-l3-loss",
      name: "Loss Streak",
      level: "L3_LIVE",
      fitness: 0.3,
      paperMetrics: makeDecayState({
        consecutiveLossDays: 4,
        rollingSharpe7d: 0.1,
      }),
    };

    const demotion = pipeline.checkDemotion(profile);
    expect(demotion.shouldDemote).toBe(true);
    expect(demotion.targetLevel).toBe("L2_PAPER");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Cumulative loss > 40% → KILLED
  // ═══════════════════════════════════════════════════════════════════════

  it("cumulative loss exceeding 40% kills the strategy", () => {
    const profile: StrategyProfile = {
      id: "sma-l3-kill",
      name: "Dead Strategy",
      level: "L3_LIVE",
      fitness: 0.1,
      paperMetrics: makeDecayState({ rollingSharpe7d: 0.1 }),
      paperEquity: 5_000,
      paperInitialCapital: 10_000, // 50% loss
    };

    const demotion = pipeline.checkDemotion(profile);
    expect(demotion.shouldDemote).toBe(true);
    expect(demotion.targetLevel).toBe("KILLED");
    expect(demotion.reasons.some((r) => r.includes("Cumulative loss"))).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13. L2 with deeply negative Sharpe → demoted to L1
  // ═══════════════════════════════════════════════════════════════════════

  it("L2 with 30d Sharpe < -0.5 is demoted to L1", () => {
    const profile: StrategyProfile = {
      id: "sma-l2-bad",
      name: "Paper Failing",
      level: "L2_PAPER",
      fitness: 0.2,
      paperMetrics: makeDecayState({
        rollingSharpe30d: -0.8,
      }),
    };

    const demotion = pipeline.checkDemotion(profile);
    expect(demotion.shouldDemote).toBe(true);
    expect(demotion.targetLevel).toBe("L1_BACKTEST");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14. Full lifecycle: create → L1 → backtest → L2 → paper → (check L3)
  // ═══════════════════════════════════════════════════════════════════════

  it("full lifecycle from L0 through L2 with real registry mutations", () => {
    // L0
    const record = createStrategy("Full Lifecycle", "sma-full-1");
    expect(record.level).toBe("L0_INCUBATE");

    // L0 → L1
    registry.updateLevel(record.id, "L1_BACKTEST");
    expect(registry.get(record.id)!.level).toBe("L1_BACKTEST");

    // Add backtest + walk-forward
    registry.updateBacktest(
      record.id,
      makeBacktestResult({ sharpe: 1.8, maxDrawdown: -12, totalTrades: 200 }),
    );
    registry.updateWalkForward(record.id, makeWalkForwardResult(true));

    // L1 → L2 check
    const l1Record = registry.get(record.id)!;
    const l1Profile = buildProfile(l1Record);
    const l1Check = pipeline.checkPromotion(l1Profile);
    expect(l1Check.eligible).toBe(true);
    expect(l1Check.targetLevel).toBe("L2_PAPER");

    // Promote to L2
    registry.updateLevel(record.id, "L2_PAPER");
    expect(registry.get(record.id)!.level).toBe("L2_PAPER");

    // Deploy paper account
    const paperAccount = paperEngine.createAccount("Full Lifecycle Paper", 10_000);
    expect(paperAccount.id).toBeDefined();
    expect(paperAccount.cash).toBe(10_000);

    // L2 → L3 check (not enough paper history yet)
    const l2Record = registry.get(record.id)!;
    const l2Profile = buildProfile(l2Record, {
      level: "L2_PAPER",
      paperDaysActive: 10,
      paperTradeCount: 5,
      paperMetrics: makeDecayState({ rollingSharpe30d: 1.0 }),
    });
    const l2Check = pipeline.checkPromotion(l2Profile);
    expect(l2Check.eligible).toBe(false);
    expect(l2Check.blockers.length).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15. Critical decay level forces immediate demotion
  // ═══════════════════════════════════════════════════════════════════════

  it("critical decay level triggers immediate L3→L2 demotion", () => {
    const profile: StrategyProfile = {
      id: "sma-l3-critical",
      name: "Critical Decay",
      level: "L3_LIVE",
      fitness: 0.1,
      paperMetrics: makeDecayState({
        decayLevel: "critical",
        rollingSharpe7d: 0.1,
      }),
    };

    const demotion = pipeline.checkDemotion(profile);
    expect(demotion.shouldDemote).toBe(true);
    expect(demotion.targetLevel).toBe("L2_PAPER");
    expect(demotion.reasons.some((r) => r.includes("critical"))).toBe(true);
  });
});
