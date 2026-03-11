/**
 * L1 Unit Tests — AlertEngine
 *
 * Tests: alert CRUD, trigger mechanics, checkAndTrigger with price feeds,
 * condition evaluation (above/below/cross), alert lifecycle
 * (create/trigger/dismiss), duplicate suppression.
 *
 * Uses a temp file SQLite DB (not :memory:) to match production WAL behavior.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AlertEngine } from "../../../extensions/findoo-trader-plugin/src/core/alert-engine.js";

// -- Helpers ------------------------------------------------------------------

let engine: AlertEngine;
let tempDir: string;

function createEngine(): AlertEngine {
  tempDir = mkdtempSync(join(tmpdir(), "alert-test-"));
  return new AlertEngine(join(tempDir, "alerts.db"));
}

// -- Tests --------------------------------------------------------------------

describe("AlertEngine — CRUD lifecycle", () => {
  beforeEach(() => {
    engine = createEngine();
  });

  afterEach(() => {
    engine.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 1. Add alert returns UUID
  it("creates an alert and returns a UUID", () => {
    const id = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // 2. List alerts returns created alert with parsed condition
  it("lists created alerts with parsed condition and message", () => {
    engine.addAlert({ kind: "price_below", symbol: "ETH/USDT", price: 2000 }, "ETH dip alert");

    const alerts = engine.listAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].condition).toEqual({
      kind: "price_below",
      symbol: "ETH/USDT",
      price: 2000,
    });
    expect(alerts[0].message).toBe("ETH dip alert");
    expect(alerts[0].notified).toBe(false);
    expect(alerts[0].triggeredAt).toBeUndefined();
  });

  // 3. Remove alert by ID
  it("removes an alert by ID and returns true", () => {
    const id = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });

    expect(engine.removeAlert(id)).toBe(true);
    expect(engine.listAlerts()).toHaveLength(0);
  });

  // 4. Remove non-existent alert returns false
  it("returns false when removing non-existent alert", () => {
    expect(engine.removeAlert("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  // 5. Multiple alerts can coexist
  it("supports multiple simultaneous alerts", () => {
    engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });
    engine.addAlert({ kind: "price_below", symbol: "ETH/USDT", price: 2000 });
    engine.addAlert({ kind: "price_above", symbol: "SOL/USDT", price: 300 });

    expect(engine.listAlerts()).toHaveLength(3);
  });
});

describe("AlertEngine — trigger mechanics", () => {
  beforeEach(() => {
    engine = createEngine();
  });

  afterEach(() => {
    engine.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 6. Trigger marks alert with timestamp
  it("marks an alert as triggered with timestamp and notified flag", () => {
    const id = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });

    expect(engine.triggerAlert(id)).toBe(true);

    const alerts = engine.listAlerts();
    expect(alerts[0].triggeredAt).toBeDefined();
    expect(alerts[0].notified).toBe(true);
  });

  // 7. Trigger non-existent alert returns false
  it("returns false when triggering non-existent alert", () => {
    expect(engine.triggerAlert("ghost-id")).toBe(false);
  });

  // 8. getActiveAlerts excludes triggered alerts
  it("getActiveAlerts returns only untriggered alerts", () => {
    const id1 = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });
    engine.addAlert({ kind: "price_below", symbol: "ETH/USDT", price: 2000 });

    engine.triggerAlert(id1);

    const active = engine.getActiveAlerts();
    expect(active).toHaveLength(1);
    expect(active[0].condition.symbol).toBe("ETH/USDT");
  });
});

describe("AlertEngine — condition evaluation (checkAndTrigger)", () => {
  beforeEach(() => {
    engine = createEngine();
  });

  afterEach(() => {
    engine.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 9. price_above triggers when current >= target
  it("triggers price_above alert when current price meets target", () => {
    const id = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });

    const triggered = engine.checkAndTrigger((sym) => (sym === "BTC/USDT" ? 100000 : undefined));

    expect(triggered).toEqual([id]);
    expect(engine.getActiveAlerts()).toHaveLength(0);
  });

  // 10. price_below triggers when current <= target
  it("triggers price_below alert when current price meets target", () => {
    const id = engine.addAlert({ kind: "price_below", symbol: "ETH/USDT", price: 2000 });

    const triggered = engine.checkAndTrigger((sym) => (sym === "ETH/USDT" ? 1999 : undefined));

    expect(triggered).toEqual([id]);
  });

  // 11. Does not trigger when price not met
  it("does not trigger alert when price condition is not met", () => {
    engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });

    const triggered = engine.checkAndTrigger((sym) => (sym === "BTC/USDT" ? 99000 : undefined));

    expect(triggered).toHaveLength(0);
    expect(engine.getActiveAlerts()).toHaveLength(1);
  });

  // 12. Skips alerts without symbol or price
  it("skips alerts without symbol or target price", () => {
    engine.addAlert({ kind: "custom_event" }); // no symbol/price

    const triggered = engine.checkAndTrigger(() => 50000);
    expect(triggered).toHaveLength(0);
  });

  // 13. Skips when getPrice returns undefined
  it("skips alerts when price feed returns undefined", () => {
    engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });

    const triggered = engine.checkAndTrigger(() => undefined);
    expect(triggered).toHaveLength(0);
  });

  // 14. Multiple alerts, partial trigger
  it("triggers only matching alerts from a batch", () => {
    engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });
    const ethId = engine.addAlert({ kind: "price_below", symbol: "ETH/USDT", price: 2000 });

    const prices: Record<string, number> = { "BTC/USDT": 95000, "ETH/USDT": 1800 };
    const triggered = engine.checkAndTrigger((sym) => prices[sym]);

    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toBe(ethId);
  });
});

describe("AlertEngine — duplicate suppression", () => {
  beforeEach(() => {
    engine = createEngine();
  });

  afterEach(() => {
    engine.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 15. Already-triggered alerts are not re-triggered
  it("does not re-trigger already triggered alerts", () => {
    engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });

    // First check triggers it
    engine.checkAndTrigger(() => 110000);

    // Second check should not re-trigger (it's no longer active)
    const triggered = engine.checkAndTrigger(() => 120000);
    expect(triggered).toHaveLength(0);
  });

  // 16. Two alerts for same symbol/condition with different targets are independent
  it("treats two alerts for the same symbol with different targets independently", () => {
    const id1 = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 90000 });
    const _id2 = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 110000 });

    // Price at 95000: only id1 triggers (90000 <= 95000)
    const triggered = engine.checkAndTrigger((sym) => (sym === "BTC/USDT" ? 95000 : undefined));

    expect(triggered).toEqual([id1]);
    expect(engine.getActiveAlerts()).toHaveLength(1);
    expect(engine.getActiveAlerts()[0].condition.price).toBe(110000);
  });

  // 17. Triggered alert stays in list but not in active
  it("keeps triggered alerts in listAlerts but excludes from getActiveAlerts", () => {
    const id = engine.addAlert({ kind: "price_above", symbol: "BTC/USDT", price: 100000 });
    engine.triggerAlert(id);

    expect(engine.listAlerts()).toHaveLength(1);
    expect(engine.getActiveAlerts()).toHaveLength(0);
  });
});
