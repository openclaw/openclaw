/**
 * L2 Integration — Order Flow
 *
 * Tests the full order lifecycle across real service instances:
 * RiskController + PaperEngine + PaperStore (SQLite).
 * External dependencies (ccxt, market calendar) are mocked;
 * all intra-plugin modules use real implementations.
 */

vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentEventStore } from "../../../extensions/findoo-trader-plugin/src/core/agent-event-store.js";
import { RiskController } from "../../../extensions/findoo-trader-plugin/src/core/risk-controller.js";
import * as marketCalendar from "../../../extensions/findoo-trader-plugin/src/paper/market-rules/market-calendar.js";
import { PaperEngine } from "../../../extensions/findoo-trader-plugin/src/paper/paper-engine.js";
import { PaperStore } from "../../../extensions/findoo-trader-plugin/src/paper/paper-store.js";
import type { TradingRiskConfig } from "../../../extensions/findoo-trader-plugin/src/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: PaperStore;
let engine: PaperEngine;
let risk: RiskController;
let events: AgentEventStore;

const defaultRiskConfig: TradingRiskConfig = {
  enabled: true,
  maxAutoTradeUsd: 500,
  confirmThresholdUsd: 5000,
  maxDailyLossUsd: 2000,
  maxPositionPct: 20,
  maxLeverage: 5,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l2-order-flow-"));
  store = new PaperStore(join(tmpDir, "paper.db"));
  engine = new PaperEngine({ store, slippageBps: 5, market: "crypto" });
  risk = new RiskController({ ...defaultRiskConfig });
  events = new AgentEventStore();

  // Crypto market is always open, but mock to be safe
  vi.spyOn(marketCalendar, "isMarketOpen").mockReturnValue(true);
  vi.spyOn(marketCalendar, "resolveMarket").mockReturnValue("crypto");
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAccount(name = "Test Account", capital = 10_000) {
  return engine.createAccount(name, capital);
}

function placeOrder(
  accountId: string,
  opts: {
    symbol?: string;
    side?: "buy" | "sell";
    quantity?: number;
    price?: number;
    strategyId?: string;
  } = {},
) {
  const symbol = opts.symbol ?? "BTC/USDT";
  const side = opts.side ?? "buy";
  const quantity = opts.quantity ?? 0.1;
  const price = opts.price ?? 50_000;

  return engine.submitOrder(
    accountId,
    { symbol, side, type: "market", quantity, strategyId: opts.strategyId },
    price,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Buy order → risk check pass → paper fill → position created
// ═══════════════════════════════════════════════════════════════════════════

describe("Order Flow — full lifecycle", () => {
  it("buy order passes risk check, fills in paper engine, creates position", () => {
    const { id: accountId } = createAccount();
    const estimatedValue = 0.1 * 50_000; // $5000
    const evaluation = risk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.1,
      },
      estimatedValue,
    );

    // Risk tier should be "confirm" (5000 > 500 auto limit, <= 5000 confirm threshold)
    expect(evaluation.tier).toBe("confirm");

    // Simulate user confirmation — proceed to paper fill
    const order = placeOrder(accountId);
    expect(order.status).toBe("filled");
    expect(order.side).toBe("buy");
    expect(order.fillPrice).toBeGreaterThan(0);

    // Position must exist
    const state = engine.getAccountState(accountId);
    expect(state).not.toBeNull();
    expect(state!.positions.length).toBe(1);
    expect(state!.positions[0].symbol).toBe("BTC/USDT");
    expect(state!.positions[0].quantity).toBe(0.1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Oversized order → risk controller rejects
  // ═══════════════════════════════════════════════════════════════════════

  it("oversized order is rejected by risk controller with clear reason", () => {
    const estimatedValue = 10_000; // > confirmThresholdUsd (5000)
    const evaluation = risk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.2,
      },
      estimatedValue,
    );

    expect(evaluation.tier).toBe("reject");
    expect(evaluation.reason).toBeDefined();
    expect(evaluation.reason).toContain("exceeds");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Small order auto-executes (under maxAutoTradeUsd)
  // ═══════════════════════════════════════════════════════════════════════

  it("small order auto-executes without confirmation", () => {
    const estimatedValue = 400; // < 500 maxAutoTradeUsd
    const evaluation = risk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.008,
      },
      estimatedValue,
    );

    expect(evaluation.tier).toBe("auto");

    // Execute on paper
    const { id } = createAccount();
    const order = placeOrder(id, { quantity: 0.008 });
    expect(order.status).toBe("filled");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Close position → PnL settlement → balance updated
  // ═══════════════════════════════════════════════════════════════════════

  it("close position settles PnL and updates cash balance", () => {
    const { id: accountId } = createAccount("PnL Test", 10_000);

    // Buy
    placeOrder(accountId, { quantity: 0.1, price: 50_000 });

    const afterBuy = engine.getAccountState(accountId)!;
    const cashAfterBuy = afterBuy.cash;
    expect(afterBuy.positions.length).toBe(1);

    // Sell at higher price → profit
    const sellOrder = engine.submitOrder(
      accountId,
      { symbol: "BTC/USDT", side: "sell", type: "market", quantity: 0.1 },
      55_000,
    );
    expect(sellOrder.status).toBe("filled");

    const afterSell = engine.getAccountState(accountId)!;
    expect(afterSell.positions.length).toBe(0);
    // Cash should have increased (profit from 50k→55k on 0.1 BTC minus fees)
    expect(afterSell.cash).toBeGreaterThan(cashAfterBuy);
    // Equity should be > initial (profit realized)
    expect(afterSell.equity).toBeGreaterThan(10_000 - 100); // allow small fee margin
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Leverage exceeds limit → rejected
  // ═══════════════════════════════════════════════════════════════════════

  it("leverage exceeding max is rejected", () => {
    const evaluation = risk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.1,
        leverage: 10,
      },
      500,
    );

    expect(evaluation.tier).toBe("reject");
    expect(evaluation.reason).toContain("Leverage");
    expect(evaluation.reason).toContain("10");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Daily loss limit → all subsequent orders rejected
  // ═══════════════════════════════════════════════════════════════════════

  it("breaching daily loss limit halts all trading", () => {
    // Record cumulative losses that exceed the limit
    risk.recordLoss(1500);
    risk.recordLoss(600); // total = 2100 > 2000

    const evaluation = risk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.001,
      },
      10,
    );

    expect(evaluation.tier).toBe("reject");
    expect(evaluation.reason).toContain("Daily loss limit");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Emergency stop (pause) → reject → resume → accept
  // ═══════════════════════════════════════════════════════════════════════

  it("emergency stop pauses trading, resume restores it", () => {
    risk.pause();
    expect(risk.isPaused()).toBe(true);

    const evalPaused = risk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.001,
      },
      10,
    );
    expect(evalPaused.tier).toBe("reject");
    expect(evalPaused.reason).toContain("paused");

    risk.resume();
    expect(risk.isPaused()).toBe(false);

    const evalResumed = risk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.001,
      },
      10,
    );
    expect(evalResumed.tier).toBe("auto");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Blocked pair → rejected
  // ═══════════════════════════════════════════════════════════════════════

  it("blocked trading pair is rejected", () => {
    const blockedRisk = new RiskController({
      ...defaultRiskConfig,
      blockedPairs: ["DOGE/USDT"],
    });

    const evaluation = blockedRisk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "DOGE/USDT",
        side: "buy",
        type: "market",
        amount: 100,
      },
      50,
    );

    expect(evaluation.tier).toBe("reject");
    expect(evaluation.reason).toContain("blocked");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Allowlist enforcement
  // ═══════════════════════════════════════════════════════════════════════

  it("pair not in allowlist is rejected", () => {
    const allowRisk = new RiskController({
      ...defaultRiskConfig,
      allowedPairs: ["BTC/USDT", "ETH/USDT"],
    });

    const evaluation = allowRisk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "SOL/USDT",
        side: "buy",
        type: "market",
        amount: 10,
      },
      100,
    );

    expect(evaluation.tier).toBe("reject");
    expect(evaluation.reason).toContain("not in the allowed");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Same symbol multiple buys → position merges (avg entry)
  // ═══════════════════════════════════════════════════════════════════════

  it("multiple buys on same symbol merge into a single position", () => {
    const { id: accountId } = createAccount("Merge Test", 100_000);

    placeOrder(accountId, { quantity: 0.1, price: 50_000 });
    placeOrder(accountId, { quantity: 0.2, price: 52_000 });

    const state = engine.getAccountState(accountId)!;
    // Should have one merged position for BTC/USDT
    const btcPositions = state.positions.filter((p) => p.symbol === "BTC/USDT");
    expect(btcPositions.length).toBe(1);
    expect(btcPositions[0].quantity).toBeCloseTo(0.3, 6);
    // Average entry should be between 50000 and 52000
    expect(btcPositions[0].entryPrice).toBeGreaterThanOrEqual(50_000);
    expect(btcPositions[0].entryPrice).toBeLessThanOrEqual(52_000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. Event store records trade events
  // ═══════════════════════════════════════════════════════════════════════

  it("trade actions produce events that can be queried", () => {
    const evt1 = events.addEvent({
      type: "trade_executed",
      title: "Buy BTC",
      detail: "0.1 BTC @ 50000",
      status: "completed",
    });

    const evt2 = events.addEvent({
      type: "trade_executed",
      title: "Sell BTC",
      detail: "0.1 BTC @ 55000",
      status: "completed",
    });

    const all = events.listEvents({ type: "trade_executed" });
    expect(all.length).toBe(2);
    expect(all[0].id).toBe(evt2.id); // newest first
    expect(all[1].id).toBe(evt1.id);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Order with strategy tracking
  // ═══════════════════════════════════════════════════════════════════════

  it("orders tagged with strategyId are queryable", () => {
    const { id: accountId } = createAccount();
    const order = placeOrder(accountId, { strategyId: "sma-001" });

    expect(order.strategyId).toBe("sma-001");
    expect(order.status).toBe("filled");

    // Verify persisted
    const orders = store.getOrders(accountId);
    expect(orders.some((o) => o.strategyId === "sma-001")).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13. Trading disabled → all orders rejected
  // ═══════════════════════════════════════════════════════════════════════

  it("disabled trading rejects all orders", () => {
    const disabledRisk = new RiskController({ ...defaultRiskConfig, enabled: false });

    const evaluation = disabledRisk.evaluate(
      {
        exchange: "binance" as unknown,
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        amount: 0.001,
      },
      1,
    );

    expect(evaluation.tier).toBe("reject");
    expect(evaluation.reason).toContain("disabled");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14. Equity snapshot after order
  // ═══════════════════════════════════════════════════════════════════════

  it("equity snapshot records state after trades", () => {
    const { id: accountId } = createAccount("Snapshot Test", 10_000);
    placeOrder(accountId, { quantity: 0.1, price: 50_000 });

    engine.recordSnapshot(accountId);
    const snapshots = engine.getSnapshots(accountId);

    expect(snapshots.length).toBe(1);
    expect(snapshots[0].accountId).toBe(accountId);
    expect(snapshots[0].equity).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15. Sell without position → order rejected or zero fill
  // ═══════════════════════════════════════════════════════════════════════

  it("selling without a position returns rejected status", () => {
    const { id: accountId } = createAccount("No Position", 10_000);

    // Attempt to sell without buying first
    const sellOrder = engine.submitOrder(
      accountId,
      { symbol: "BTC/USDT", side: "sell", type: "market", quantity: 0.1 },
      50_000,
    );

    // Should be rejected because there's no sellable quantity
    expect(sellOrder.status).toBe("rejected");
    expect(sellOrder.reason).toBeDefined();
  });
});
