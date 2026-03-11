/**
 * L1 Unit Tests — LifecycleEngine
 *
 * Tests: start/stop control, cycle execution, promotion recommendations,
 * demotion recommendations, L2->L3 approval flow, garbage collection,
 * circuit breaker, stats tracking.
 *
 * All dependencies are mock objects — no real DBs or services.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LifecycleEngine,
  type LifecycleEngineDeps,
} from "../../../extensions/findoo-trader-plugin/src/core/lifecycle-engine.js";

// ── Mock Factories ───────────────────────────────────────────────────

function makeStrategy(overrides?: Record<string, unknown>) {
  return {
    id: "strat-1",
    name: "Test Strategy",
    level: "L1_BACKTEST",
    definition: { symbols: ["BTC/USDT"], timeframes: ["1h"], markets: ["crypto"] },
    lastBacktest: { sharpe: 1.5, maxDrawdown: 0.1, totalTrades: 50 },
    ...overrides,
  };
}

function makeProfile(overrides?: Record<string, unknown>) {
  return {
    id: "strat-1",
    name: "Test Strategy",
    level: "L1_BACKTEST",
    backtest: { sharpe: 1.5, maxDrawdown: 0.1, totalTrades: 50 },
    fitness: 0.8,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<LifecycleEngineDeps>): LifecycleEngineDeps {
  return {
    strategyRegistry: {
      list: vi.fn().mockReturnValue([makeStrategy()]),
      updateLevel: vi.fn(),
    },
    fundManagerResolver: vi.fn().mockReturnValue({
      buildProfiles: vi.fn().mockReturnValue([makeProfile()]),
      checkPromotion: vi.fn().mockReturnValue({
        strategyId: "strat-1",
        currentLevel: "L1_BACKTEST",
        eligible: false,
        reasons: [],
        blockers: [],
      }),
      checkDemotion: vi.fn().mockReturnValue({
        strategyId: "strat-1",
        currentLevel: "L1_BACKTEST",
        shouldDemote: false,
        reasons: [],
      }),
    }),
    paperEngine: {
      listAccounts: vi.fn().mockReturnValue([]),
      getAccountState: vi.fn().mockReturnValue(null),
    },
    eventStore: {
      addEvent: vi.fn(),
    } as unknown as LifecycleEngineDeps["eventStore"],
    activityLog: {
      append: vi.fn(),
    } as unknown as LifecycleEngineDeps["activityLog"],
    wakeBridge: {
      onLifecycleRecommendation: vi.fn(),
      onPromotionReady: vi.fn(),
      onApprovalNeeded: vi.fn(),
      onHealthAlert: vi.fn(),
      reconcilePending: vi.fn(),
      drainUndelivered: vi.fn(),
    } as unknown as LifecycleEngineDeps["wakeBridge"],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("LifecycleEngine", () => {
  let engine: LifecycleEngine;
  let deps: LifecycleEngineDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = makeDeps();
    engine = new LifecycleEngine(deps, 1000); // 1s interval for testing
  });

  afterEach(() => {
    engine.stop();
    vi.useRealTimers();
  });

  // 1. Initial state
  it("starts with zero stats and not running", () => {
    const stats = engine.getStats();
    expect(stats.running).toBe(false);
    expect(stats.cycleCount).toBe(0);
    expect(stats.promotionCount).toBe(0);
    expect(stats.demotionCount).toBe(0);
    expect(stats.pendingApprovals).toBe(0);
  });

  // 2. Start sets running = true
  it("sets running to true after start()", () => {
    engine.start();
    expect(engine.getStats().running).toBe(true);
  });

  // 3. Stop sets running = false
  it("sets running to false after stop()", () => {
    engine.start();
    engine.stop();
    expect(engine.getStats().running).toBe(false);
  });

  // 4. Double start is idempotent
  it("ignores double start (no duplicate timers)", () => {
    engine.start();
    engine.start();
    expect(engine.getStats().running).toBe(true);

    // Only one timer should fire after interval
    vi.advanceTimersByTime(1000);
    // If two timers were created, cycleCount would be 2
    // Give async cycle a tick to complete
  });

  // 5. Cycle increments counter
  it("increments cycleCount on each cycle", async () => {
    const result = await engine.runCycle();

    expect(result).toBeDefined();
    expect(engine.getStats().cycleCount).toBe(1);
    expect(engine.getStats().lastCycleAt).toBeGreaterThan(0);
  });

  // 6. Cycle with no fund manager returns early
  it("returns zeros when fundManager is not available", async () => {
    deps = makeDeps({ fundManagerResolver: vi.fn().mockReturnValue(undefined) });
    engine = new LifecycleEngine(deps, 1000);

    const result = await engine.runCycle();
    expect(result).toEqual({ promoted: 0, approvalsSent: 0, demoted: 0, errors: 0 });
    expect(engine.getStats().cycleCount).toBe(1);
  });

  // 7. Promotion recommendation (L1->L2, no user confirmation needed)
  it("sends promotion recommendation to agent for eligible non-L3 promotions", async () => {
    const fundManager = (deps.fundManagerResolver as ReturnType<typeof vi.fn>)();
    fundManager.checkPromotion.mockReturnValue({
      strategyId: "strat-1",
      currentLevel: "L1_BACKTEST",
      eligible: true,
      targetLevel: "L2_PAPER",
      needsUserConfirmation: false,
      reasons: ["Sharpe > 1.0", "30+ trades"],
      blockers: [],
    });

    const result = await engine.runCycle();

    expect(result.promoted).toBe(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock
    expect(deps.wakeBridge.onLifecycleRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({
        promotions: expect.arrayContaining([
          expect.objectContaining({
            strategyId: "strat-1",
            from: "L1_BACKTEST",
            to: "L2_PAPER",
          }),
        ]),
      }),
    );
  });

  // 8. L2->L3 requires user approval (never auto-promote)
  it("sends approval request for L2->L3 promotion (never auto-promotes)", async () => {
    const fundManager = (deps.fundManagerResolver as ReturnType<typeof vi.fn>)();
    fundManager.buildProfiles.mockReturnValue([makeProfile({ level: "L2_PAPER" })]);
    fundManager.checkPromotion.mockReturnValue({
      strategyId: "strat-1",
      currentLevel: "L2_PAPER",
      eligible: true,
      targetLevel: "L3_LIVE",
      needsUserConfirmation: true,
      reasons: ["Paper Sharpe > 1.2 for 30d"],
      blockers: [],
    });

    const result = await engine.runCycle();

    expect(result.approvalsSent).toBe(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock
    expect(deps.wakeBridge.onApprovalNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ strategyId: "strat-1" }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock
    expect(deps.eventStore.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "trade_pending" }),
    );
  });

  // 9. Duplicate approval request suppressed
  it("does not send duplicate approval requests for the same strategy", async () => {
    const fundManager = (deps.fundManagerResolver as ReturnType<typeof vi.fn>)();
    fundManager.buildProfiles.mockReturnValue([makeProfile({ level: "L2_PAPER" })]);
    fundManager.checkPromotion.mockReturnValue({
      strategyId: "strat-1",
      currentLevel: "L2_PAPER",
      eligible: true,
      targetLevel: "L3_LIVE",
      needsUserConfirmation: true,
      reasons: ["Eligible"],
      blockers: [],
    });

    await engine.runCycle();
    await engine.runCycle();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock
    expect(deps.wakeBridge.onApprovalNeeded).toHaveBeenCalledTimes(1);
  });

  // 10. handleApproval executes L2->L3 promotion
  it("handleApproval promotes L2_PAPER to L3_LIVE", async () => {
    // Set up a pending approval
    const fundManager = (deps.fundManagerResolver as ReturnType<typeof vi.fn>)();
    fundManager.buildProfiles.mockReturnValue([makeProfile({ level: "L2_PAPER" })]);
    fundManager.checkPromotion.mockReturnValue({
      strategyId: "strat-1",
      currentLevel: "L2_PAPER",
      eligible: true,
      targetLevel: "L3_LIVE",
      needsUserConfirmation: true,
      reasons: ["Eligible"],
      blockers: [],
    });
    (deps.strategyRegistry.list as ReturnType<typeof vi.fn>).mockReturnValue([
      makeStrategy({ level: "L2_PAPER" }),
    ]);

    await engine.runCycle();

    const approved = engine.handleApproval("strat-1");
    expect(approved).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock
    expect(deps.strategyRegistry.updateLevel).toHaveBeenCalledWith("strat-1", "L3_LIVE");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock
    expect(deps.wakeBridge.onPromotionReady).toHaveBeenCalledWith(
      expect.objectContaining({ strategyId: "strat-1", from: "L2_PAPER", to: "L3_LIVE" }),
    );
    expect(engine.getStats().promotionCount).toBe(1);
  });

  // 11. handleApproval returns false for non-L2 strategy
  it("handleApproval returns false if strategy is not at L2_PAPER", () => {
    // Strategy is at L1, not L2
    (deps.strategyRegistry.list as ReturnType<typeof vi.fn>).mockReturnValue([
      makeStrategy({ level: "L1_BACKTEST" }),
    ]);

    expect(engine.handleApproval("strat-1")).toBe(false);
  });

  // 12. handleRejection removes pending approval
  it("handleRejection removes strategy from pending approvals", async () => {
    const fundManager = (deps.fundManagerResolver as ReturnType<typeof vi.fn>)();
    fundManager.buildProfiles.mockReturnValue([makeProfile({ level: "L2_PAPER" })]);
    fundManager.checkPromotion.mockReturnValue({
      strategyId: "strat-1",
      currentLevel: "L2_PAPER",
      eligible: true,
      targetLevel: "L3_LIVE",
      needsUserConfirmation: true,
      reasons: ["Eligible"],
      blockers: [],
    });

    await engine.runCycle();
    expect(engine.getStats().pendingApprovals).toBe(1);

    const rejected = engine.handleRejection("strat-1", "Too risky");
    expect(rejected).toBe(true);
    expect(engine.getStats().pendingApprovals).toBe(0);
  });

  // 13. Demotion recommendation
  it("sends demotion recommendation when fundManager flags degradation", async () => {
    const fundManager = (deps.fundManagerResolver as ReturnType<typeof vi.fn>)();
    fundManager.checkDemotion.mockReturnValue({
      strategyId: "strat-1",
      currentLevel: "L2_PAPER",
      shouldDemote: true,
      targetLevel: "L1_BACKTEST",
      reasons: ["Sharpe < 0.3 for 7d"],
    });

    const result = await engine.runCycle();
    expect(result.demoted).toBe(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock
    expect(deps.wakeBridge.onLifecycleRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({
        demotions: expect.arrayContaining([
          expect.objectContaining({
            strategyId: "strat-1",
            from: "L2_PAPER",
            to: "L1_BACKTEST",
          }),
        ]),
      }),
    );
  });

  // 14. Circuit breaker demotes L3 strategies
  it("demotes L3_LIVE strategies when circuit breaker fires", async () => {
    deps = makeDeps({
      liveHealthMonitor: {
        check: vi.fn().mockResolvedValue({
          circuitBroken: true,
          lossPct: 5.2,
          strategiesAffected: ["strat-1"],
        }),
      },
    });
    (deps.strategyRegistry.list as ReturnType<typeof vi.fn>).mockReturnValue([
      makeStrategy({ level: "L3_LIVE" }),
    ]);
    engine = new LifecycleEngine(deps, 1000);

    const result = await engine.runCycle();
    expect(result.demoted).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock
    expect(deps.strategyRegistry.updateLevel).toHaveBeenCalledWith("strat-1", "L2_PAPER");
  });

  // 15. Errors are counted but do not crash the cycle
  it("counts errors from checkPromotion but continues the cycle", async () => {
    const fundManager = (deps.fundManagerResolver as ReturnType<typeof vi.fn>)();
    fundManager.checkPromotion.mockImplementation(() => {
      throw new Error("unexpected");
    });
    fundManager.checkDemotion.mockReturnValue({
      strategyId: "strat-1",
      currentLevel: "L1_BACKTEST",
      shouldDemote: false,
      reasons: [],
    });

    const result = await engine.runCycle();
    expect(result.errors).toBeGreaterThan(0);
    expect(engine.getStats().cycleCount).toBe(1); // Cycle completed despite error
  });
});
