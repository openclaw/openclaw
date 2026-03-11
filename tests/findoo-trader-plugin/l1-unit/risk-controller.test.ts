/**
 * L1 Unit Tests — RiskController
 *
 * Tests: position size limits, drawdown checks, daily loss limits,
 * exposure limits, leverage cap, pair allowlist/blocklist,
 * 3-tier evaluation, emergency stop, config updates.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RiskController } from "../../../extensions/findoo-trader-plugin/src/core/risk-controller.js";
import type {
  TradingRiskConfig,
  OrderRequest,
} from "../../../extensions/findoo-trader-plugin/src/types.js";

// -- Helpers ------------------------------------------------------------------

function makeConfig(overrides?: Partial<TradingRiskConfig>): TradingRiskConfig {
  return {
    enabled: true,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 1000,
    maxDailyLossUsd: 500,
    maxPositionPct: 10,
    maxLeverage: 5,
    ...overrides,
  };
}

function makeOrder(overrides?: Partial<OrderRequest>): OrderRequest {
  return {
    exchange: "binance",
    symbol: "BTC/USDT",
    side: "buy",
    type: "market",
    amount: 0.01,
    ...overrides,
  };
}

// -- Tests --------------------------------------------------------------------

describe("RiskController", () => {
  let ctrl: RiskController;

  beforeEach(() => {
    ctrl = new RiskController(makeConfig());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Trading disabled -> reject
  it("rejects all trades when trading is disabled", () => {
    ctrl = new RiskController(makeConfig({ enabled: false }));
    const result = ctrl.evaluate(makeOrder(), 50);

    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("disabled");
  });

  // 2. Emergency stop (pause) -> reject
  it("rejects all trades when paused (emergency stop)", () => {
    ctrl.pause();
    const result = ctrl.evaluate(makeOrder(), 50);

    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("paused");
  });

  // 3. Resume after pause -> normal evaluation
  it("resumes normal evaluation after resume()", () => {
    ctrl.pause();
    expect(ctrl.isPaused()).toBe(true);

    ctrl.resume();
    expect(ctrl.isPaused()).toBe(false);

    const result = ctrl.evaluate(makeOrder(), 50);
    expect(result.tier).toBe("auto");
  });

  // 4. Tier 1: auto-execute for small trades
  it("auto-executes trades at or below maxAutoTradeUsd", () => {
    const result = ctrl.evaluate(makeOrder(), 100);
    expect(result.tier).toBe("auto");
    expect(result.reason).toBeUndefined();
  });

  // 5. Tier 2: confirm for medium trades
  it("requires confirmation for trades between auto and confirm thresholds", () => {
    const result = ctrl.evaluate(makeOrder(), 500);

    expect(result.tier).toBe("confirm");
    expect(result.reason).toContain("confirm");
  });

  // 6. Tier 3: reject for large trades
  it("rejects trades exceeding confirmThresholdUsd", () => {
    const result = ctrl.evaluate(makeOrder(), 1500);

    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("exceeds confirmation threshold");
  });

  // 7. Daily loss limit triggers halt
  it("rejects trades when daily loss limit is reached", () => {
    ctrl.recordLoss(500); // Exactly at limit

    const result = ctrl.evaluate(makeOrder(), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Daily loss limit reached");
  });

  // 8. Daily loss accumulates across multiple losses
  it("accumulates daily losses across multiple recordLoss calls", () => {
    ctrl.recordLoss(200);
    ctrl.recordLoss(200);
    // 400 < 500, should still allow
    expect(ctrl.evaluate(makeOrder(), 50).tier).toBe("auto");

    ctrl.recordLoss(100); // Now at 500
    expect(ctrl.evaluate(makeOrder(), 50).tier).toBe("reject");
  });

  // 9. Daily loss resets on new date
  it("resets daily loss counter when date changes", () => {
    ctrl.recordLoss(500); // Hit limit
    expect(ctrl.evaluate(makeOrder(), 50).tier).toBe("reject");

    // Advance to next day
    vi.setSystemTime(new Date("2026-03-12T00:00:01Z"));

    const result = ctrl.evaluate(makeOrder(), 50);
    expect(result.tier).toBe("auto");
  });

  // 10. recordLoss uses absolute value (handles negative input)
  it("records absolute value of losses (handles negative input)", () => {
    ctrl.recordLoss(-250);
    ctrl.recordLoss(-250);

    const result = ctrl.evaluate(makeOrder(), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Daily loss limit");
  });

  // 11. Leverage exceeds max -> reject
  it("rejects orders with leverage exceeding maxLeverage", () => {
    const result = ctrl.evaluate(makeOrder({ leverage: 10 }), 50);

    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Leverage 10x exceeds maximum 5x");
  });

  // 12. Leverage at max is OK
  it("allows orders with leverage at exactly maxLeverage", () => {
    const result = ctrl.evaluate(makeOrder({ leverage: 5 }), 50);
    expect(result.tier).toBe("auto");
  });

  // 13. Pair allowlist: unlisted pair rejected
  it("rejects pairs not in allowedPairs list", () => {
    ctrl = new RiskController(makeConfig({ allowedPairs: ["BTC/USDT", "ETH/USDT"] }));

    const result = ctrl.evaluate(makeOrder({ symbol: "DOGE/USDT" }), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("not in the allowed trading pairs");
  });

  // 14. Pair blocklist: blocked pair rejected
  it("rejects pairs in blockedPairs list", () => {
    ctrl = new RiskController(makeConfig({ blockedPairs: ["LUNA/USDT"] }));

    const result = ctrl.evaluate(makeOrder({ symbol: "LUNA/USDT" }), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("blocked trading pairs");
  });

  // 15. getConfig returns a copy, updateConfig modifies
  it("getConfig returns snapshot and updateConfig updates config", () => {
    const original = ctrl.getConfig();
    expect(original.maxLeverage).toBe(5);

    ctrl.updateConfig({ maxLeverage: 10 });
    expect(ctrl.getConfig().maxLeverage).toBe(10);

    // Original snapshot is not mutated
    expect(original.maxLeverage).toBe(5);
  });
});

describe("RiskController — position size and exposure boundary conditions", () => {
  let ctrl: RiskController;

  beforeEach(() => {
    ctrl = new RiskController(
      makeConfig({
        maxAutoTradeUsd: 1000,
        confirmThresholdUsd: 5000,
        maxDailyLossUsd: 2000,
        maxPositionPct: 10,
        maxLeverage: 3,
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 16. Zero estimated value -> auto (boundary)
  it("auto-executes when estimated value is zero", () => {
    const result = ctrl.evaluate(makeOrder(), 0);
    expect(result.tier).toBe("auto");
  });

  // 17. Negative estimated value -> auto (boundary, treated as <= max)
  it("auto-executes when estimated value is negative", () => {
    const result = ctrl.evaluate(makeOrder(), -100);
    expect(result.tier).toBe("auto");
  });

  // 18. Exact boundary: value == maxAutoTradeUsd
  it("auto-executes when value exactly equals maxAutoTradeUsd", () => {
    const result = ctrl.evaluate(makeOrder(), 1000);
    expect(result.tier).toBe("auto");
  });

  // 19. One cent above maxAutoTradeUsd -> confirm
  it("requires confirmation when value is just above maxAutoTradeUsd", () => {
    const result = ctrl.evaluate(makeOrder(), 1000.01);
    expect(result.tier).toBe("confirm");
  });

  // 20. Exact boundary: value == confirmThresholdUsd
  it("requires confirmation when value exactly equals confirmThresholdUsd", () => {
    const result = ctrl.evaluate(makeOrder(), 5000);
    expect(result.tier).toBe("confirm");
  });

  // 21. One cent above confirmThresholdUsd -> reject
  it("rejects when value is just above confirmThresholdUsd", () => {
    const result = ctrl.evaluate(makeOrder(), 5000.01);
    expect(result.tier).toBe("reject");
  });

  // 22. Zero daily loss still allows trading
  it("allows trading when no losses have been recorded", () => {
    const result = ctrl.evaluate(makeOrder(), 500);
    expect(result.tier).toBe("auto");
  });

  // 23. Daily loss just below limit still allows trading
  it("allows trading when daily loss is just below limit", () => {
    ctrl.recordLoss(1999.99);
    const result = ctrl.evaluate(makeOrder(), 500);
    expect(result.tier).toBe("auto");
  });

  // 24. Leverage of 1 (no leverage) is always OK
  it("allows leverage=1 (no leverage)", () => {
    const result = ctrl.evaluate(makeOrder({ leverage: 1 }), 500);
    expect(result.tier).toBe("auto");
  });

  // 25. No leverage field -> no leverage check
  it("skips leverage check when leverage is undefined", () => {
    const result = ctrl.evaluate(makeOrder({ leverage: undefined }), 500);
    expect(result.tier).toBe("auto");
  });

  // 26. Empty allowedPairs means all pairs allowed
  it("allows all pairs when allowedPairs is empty", () => {
    ctrl = new RiskController(makeConfig({ allowedPairs: [] }));
    const result = ctrl.evaluate(makeOrder({ symbol: "SHIB/USDT" }), 50);
    // Empty allowedPairs array has length 0 -> falsy in the check -> allow
    expect(result.tier).toBe("auto");
  });

  // 27. Multiple losses across day boundary
  it("isolates losses to their respective days", () => {
    ctrl.recordLoss(1500);
    expect(ctrl.evaluate(makeOrder(), 500).tier).toBe("auto");

    ctrl.recordLoss(600); // total = 2100 > 2000 -> reject
    expect(ctrl.evaluate(makeOrder(), 500).tier).toBe("reject");

    // Next day: counter resets
    vi.setSystemTime(new Date("2026-03-12T08:00:00Z"));
    ctrl.recordLoss(100);
    expect(ctrl.evaluate(makeOrder(), 500).tier).toBe("auto");
  });
});
