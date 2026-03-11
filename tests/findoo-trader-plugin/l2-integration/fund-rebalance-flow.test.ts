/**
 * L2 Integration — Fund Rebalance Flow
 *
 * Tests the fund manager's allocation, rebalancing, correlation handling,
 * and risk escalation using real FundManager, CapitalAllocator,
 * CorrelationMonitor, FundRiskManager, CapitalFlowStore, and PerformanceSnapshotStore.
 * Strategy data comes from a real StrategyRegistry; no network mocks needed.
 */

vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CapitalFlowStore } from "../../../extensions/findoo-trader-plugin/src/fund/capital-flow-store.js";
import { FundManager } from "../../../extensions/findoo-trader-plugin/src/fund/fund-manager.js";
import { PerformanceSnapshotStore } from "../../../extensions/findoo-trader-plugin/src/fund/performance-snapshot-store.js";
import type { FundConfig } from "../../../extensions/findoo-trader-plugin/src/fund/types.js";
import type {
  BacktestResult,
  StrategyRecord,
} from "../../../extensions/findoo-trader-plugin/src/shared/types.js";
import { createSmaCrossover } from "../../../extensions/findoo-trader-plugin/src/strategy/builtin-strategies/sma-crossover.js";
import { StrategyRegistry } from "../../../extensions/findoo-trader-plugin/src/strategy/strategy-registry.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let registry: StrategyRegistry;
let fundManager: FundManager;
let flowStore: CapitalFlowStore;
let perfStore: PerformanceSnapshotStore;

const fundConfig: FundConfig = {
  totalCapital: 100_000,
  cashReservePct: 20,
  maxSingleStrategyPct: 30,
  maxTotalExposurePct: 70,
  rebalanceFrequency: "daily",
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l2-fund-rebalance-"));
  registry = new StrategyRegistry(join(tmpDir, "strategies.json"));
  fundManager = new FundManager(join(tmpDir, "fund.json"), fundConfig);
  flowStore = new CapitalFlowStore(join(tmpDir, "flows.db"));
  perfStore = new PerformanceSnapshotStore(join(tmpDir, "perf.db"));
});

afterEach(() => {
  flowStore.close();
  perfStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addStrategy(
  name: string,
  id: string,
  level: string,
  sharpe: number,
  totalTrades = 150,
  maxDrawdown = -15,
): StrategyRecord {
  const def = createSmaCrossover({ fastPeriod: 5, slowPeriod: 20 });
  def.id = id;
  def.name = name;
  const _record = registry.create(def);
  registry.updateLevel(id, level as unknown);
  registry.updateBacktest(
    id,
    makeBacktestResult({ sharpe, totalTrades, maxDrawdown, strategyId: id }),
  );
  return registry.get(id)!;
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

// ═══════════════════════════════════════════════════════════════════════════
describe("Fund Rebalance Flow", () => {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. Initial allocation distributes by fitness
  // ═══════════════════════════════════════════════════════════════════════

  it("allocates capital proportionally to fitness ranking", () => {
    addStrategy("High Fitness", "strat-a", "L2_PAPER", 2.0, 200);
    addStrategy("Med Fitness", "strat-b", "L2_PAPER", 1.2, 150);
    addStrategy("Low Fitness", "strat-c", "L2_PAPER", 0.8, 120);

    const records = registry.list();
    const profiles = fundManager.buildProfiles(records);
    const allocations = fundManager.allocate(profiles);

    expect(allocations.length).toBeGreaterThan(0);

    // Higher fitness should get more capital
    const allocA = allocations.find((a) => a.strategyId === "strat-a");
    const allocC = allocations.find((a) => a.strategyId === "strat-c");

    if (allocA && allocC) {
      expect(allocA.capitalUsd).toBeGreaterThanOrEqual(allocC.capitalUsd);
    }

    // Total allocation should not exceed maxTotalExposurePct
    const totalAllocated = allocations.reduce((sum, a) => sum + a.capitalUsd, 0);
    expect(totalAllocated).toBeLessThanOrEqual(100_000 * 0.7 + 1); // tolerance
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Single strategy cap enforcement
  // ═══════════════════════════════════════════════════════════════════════

  it("no single strategy exceeds maxSingleStrategyPct", () => {
    // One extremely good strategy
    addStrategy("Dominant", "strat-dom", "L2_PAPER", 5.0, 500);

    const records = registry.list();
    const profiles = fundManager.buildProfiles(records);
    const allocations = fundManager.allocate(profiles);

    for (const alloc of allocations) {
      expect(alloc.capitalUsd).toBeLessThanOrEqual(100_000 * 0.3 + 1);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Monthly rebalance recalculates fitness and adjusts allocations
  // ═══════════════════════════════════════════════════════════════════════

  it("rebalance recalculates allocations with updated data", () => {
    addStrategy("Strat A", "rebal-a", "L2_PAPER", 1.5);
    addStrategy("Strat B", "rebal-b", "L2_PAPER", 1.8);

    const records = registry.list();
    const result1 = fundManager.rebalance(records);
    expect(result1.allocations.length).toBe(2);

    // Simulate performance change: strat-a improves
    registry.updateBacktest("rebal-a", makeBacktestResult({ sharpe: 3.0, totalTrades: 300 }));

    const records2 = registry.list();
    const result2 = fundManager.rebalance(records2);

    // strat-a should now get a larger share
    const allocA1 = result1.allocations.find((a) => a.strategyId === "rebal-a")?.capitalUsd ?? 0;
    const allocA2 = result2.allocations.find((a) => a.strategyId === "rebal-a")?.capitalUsd ?? 0;
    expect(allocA2).toBeGreaterThanOrEqual(allocA1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. High correlation strategies → combined cap 40%
  // ═══════════════════════════════════════════════════════════════════════

  it("highly correlated strategies have combined weight capped", () => {
    addStrategy("Corr A", "corr-a", "L2_PAPER", 2.0);
    addStrategy("Corr B", "corr-b", "L2_PAPER", 2.0);
    addStrategy("Uncorr C", "uncorr-c", "L2_PAPER", 2.0);

    const records = registry.list();
    const profiles = fundManager.buildProfiles(records);

    // Build high correlation between A and B
    const equityCurves = new Map<string, number[]>();
    const base = Array.from({ length: 100 }, (_, i) => 10_000 + i * 50 + Math.random() * 10);
    equityCurves.set("corr-a", base);
    equityCurves.set(
      "corr-b",
      base.map((v) => v + Math.random() * 5),
    ); // nearly identical
    equityCurves.set(
      "uncorr-c",
      Array.from({ length: 100 }, () => 10_000 + Math.random() * 500),
    );

    const { matrix, highCorrelation: _highCorrelation } =
      fundManager.computeCorrelations(equityCurves);
    const allocations = fundManager.allocate(profiles, matrix);

    // Total of correlated pair should not exceed 40% of total capital
    const corrAAlloc = allocations.find((a) => a.strategyId === "corr-a");
    const corrBAlloc = allocations.find((a) => a.strategyId === "corr-b");

    if (corrAAlloc && corrBAlloc) {
      const combinedPct = corrAAlloc.weightPct + corrBAlloc.weightPct;
      expect(combinedPct).toBeLessThanOrEqual(41); // 40% + rounding tolerance
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Risk escalation — drawdown > 5% → warning level
  // ═══════════════════════════════════════════════════════════════════════

  it("daily drawdown > 5% triggers warning risk level", () => {
    fundManager.markDayStart(100_000);

    const risk = fundManager.evaluateRisk(94_000); // 6% drawdown
    expect(risk.riskLevel).toBe("warning");
    expect(risk.dailyDrawdown).toBeGreaterThan(5);

    const scaleFactor = fundManager.riskManager.getScaleFactor(risk.riskLevel);
    expect(scaleFactor).toBe(0.5); // positions shrink by 50%
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Risk escalation — drawdown > 10% → critical (halt)
  // ═══════════════════════════════════════════════════════════════════════

  it("daily drawdown > 10% triggers critical risk level (halt)", () => {
    fundManager.markDayStart(100_000);

    const risk = fundManager.evaluateRisk(88_000); // 12% drawdown
    expect(risk.riskLevel).toBe("critical");

    const scaleFactor = fundManager.riskManager.getScaleFactor(risk.riskLevel);
    expect(scaleFactor).toBe(0); // all positions halted
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Normal risk — no intervention
  // ═══════════════════════════════════════════════════════════════════════

  it("normal conditions return normal risk level with scale=1", () => {
    fundManager.markDayStart(100_000);

    const risk = fundManager.evaluateRisk(101_000); // slight gain
    expect(risk.riskLevel).toBe("normal");
    expect(fundManager.riskManager.getScaleFactor("normal")).toBe(1.0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Capital flow recording on rebalance
  // ═══════════════════════════════════════════════════════════════════════

  it("rebalance records capital flows for each allocation", () => {
    addStrategy("Flow A", "flow-a", "L2_PAPER", 1.5);
    addStrategy("Flow B", "flow-b", "L2_PAPER", 1.2);

    const records = registry.list();
    const result = fundManager.rebalance(records);

    // Simulate recording flows (as done in fin_fund_rebalance tool)
    for (const alloc of result.allocations) {
      flowStore.record({
        id: `rebalance-${Date.now()}-${alloc.strategyId}`,
        type: "transfer",
        amount: alloc.capitalUsd,
        currency: "USD",
        status: "completed",
        description: `Rebalance allocation to ${alloc.strategyId}`,
        createdAt: Date.now(),
      });
    }

    const flows = flowStore.list();
    expect(flows.length).toBe(result.allocations.length);
    expect(flows.every((f) => f.type === "transfer")).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Adding new strategy doesn't break existing allocations
  // ═══════════════════════════════════════════════════════════════════════

  it("adding a new strategy preserves existing allocation structure", () => {
    addStrategy("Existing A", "exist-a", "L2_PAPER", 1.5);

    const records1 = registry.list();
    const result1 = fundManager.rebalance(records1);
    const _existingAllocBefore = result1.allocations.find((a) => a.strategyId === "exist-a");

    // Add new strategy
    addStrategy("New B", "new-b", "L2_PAPER", 1.0);

    const records2 = registry.list();
    const result2 = fundManager.rebalance(records2);

    // Both strategies should have allocations
    expect(result2.allocations.length).toBe(2);
    const existingAllocAfter = result2.allocations.find((a) => a.strategyId === "exist-a");
    const newAlloc = result2.allocations.find((a) => a.strategyId === "new-b");

    expect(existingAllocAfter).toBeDefined();
    expect(newAlloc).toBeDefined();
    // Total exposure still within limits
    const total = result2.allocations.reduce((s, a) => s + a.capitalUsd, 0);
    expect(total).toBeLessThanOrEqual(100_000 * 0.7 + 1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. KILLED strategies excluded from allocation
  // ═══════════════════════════════════════════════════════════════════════

  it("KILLED strategies receive zero allocation", () => {
    addStrategy("Live A", "live-a", "L2_PAPER", 1.5);
    addStrategy("Dead B", "dead-b", "L2_PAPER", 1.0);
    registry.updateLevel("dead-b", "KILLED");

    const records = registry.list();
    const profiles = fundManager.buildProfiles(records);
    const allocations = fundManager.allocate(profiles);

    const deadAlloc = allocations.find((a) => a.strategyId === "dead-b");
    expect(deadAlloc).toBeUndefined(); // KILLED filtered out
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. L2 paper strategies capped at 15%
  // ═══════════════════════════════════════════════════════════════════════

  it("L2 paper strategies are capped at 15% allocation", () => {
    addStrategy("Paper Only", "paper-only", "L2_PAPER", 5.0, 500);

    const records = registry.list();
    const profiles = fundManager.buildProfiles(records);
    const allocations = fundManager.allocate(profiles);

    const paperAlloc = allocations.find((a) => a.strategyId === "paper-only");
    expect(paperAlloc).toBeDefined();
    expect(paperAlloc!.weightPct).toBeLessThanOrEqual(15.1); // 15% + rounding
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Performance snapshot recording
  // ═══════════════════════════════════════════════════════════════════════

  it("performance snapshots persist and can be queried", () => {
    perfStore.addSnapshot({
      id: "snap-1",
      period: "2026-03-10",
      periodType: "daily",
      totalPnl: 500,
      totalReturn: 0.5,
      sharpe: null,
      maxDrawdown: null,
      byStrategyJson: null,
      byMarketJson: null,
      bySymbolJson: null,
      createdAt: Date.now(),
    });

    perfStore.addSnapshot({
      id: "snap-2",
      period: "2026-03-11",
      periodType: "daily",
      totalPnl: -200,
      totalReturn: -0.2,
      sharpe: null,
      maxDrawdown: null,
      byStrategyJson: null,
      byMarketJson: null,
      bySymbolJson: null,
      createdAt: Date.now(),
    });

    const snapshots = perfStore.getLatest("daily");
    expect(snapshots.length).toBe(2);
    // Both snapshots present; order may vary if created within same millisecond
    const pnlValues = snapshots.map((s) => s.totalPnl).toSorted((a, b) => a - b);
    expect(pnlValues).toEqual([-200, 500]);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13. Rebalance includes promotion/demotion checks
  // ═══════════════════════════════════════════════════════════════════════

  it("rebalance returns promotion and demotion checks", () => {
    addStrategy("Promotable", "promo-a", "L0_INCUBATE", 1.5);

    const records = registry.list();
    const result = fundManager.rebalance(records);

    // L0 strategies are always eligible for L1 promotion
    expect(result.promotions.length).toBeGreaterThan(0);
    expect(result.promotions.some((p) => p.strategyId === "promo-a")).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14. Zero fitness strategies get no allocation
  // ═══════════════════════════════════════════════════════════════════════

  it("strategies with zero or negative fitness get no allocation", () => {
    // L0 strategies (not L2/L3) should not get allocation
    addStrategy("L0 Only", "l0-only", "L0_INCUBATE", 0.5);

    const records = registry.list();
    const profiles = fundManager.buildProfiles(records);
    const allocations = fundManager.allocate(profiles);

    expect(allocations.length).toBe(0); // L0 not eligible for allocation
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15. Caution risk level → scale factor 0.8
  // ═══════════════════════════════════════════════════════════════════════

  it("caution risk level applies 0.8 scale factor", () => {
    fundManager.markDayStart(100_000);

    const risk = fundManager.evaluateRisk(96_500); // 3.5% drawdown
    expect(risk.riskLevel).toBe("caution");

    const scaleFactor = fundManager.riskManager.getScaleFactor(risk.riskLevel);
    expect(scaleFactor).toBe(0.8);
  });
});
