/**
 * L2 Integration — Event Sourcing
 *
 * Tests the AgentEventStore (in-memory) and AgentEventSqliteStore (persistent)
 * for event recording, replay, subscription, filtering, and concurrent operations.
 * Uses real implementations; no mocks.
 */

vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentEventSqliteStore } from "../../../extensions/findoo-trader-plugin/src/core/agent-event-sqlite-store.js";
import {
  AgentEventStore,
  type AgentEvent,
  type AgentEventType,
} from "../../../extensions/findoo-trader-plugin/src/core/agent-event-store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let memStore: AgentEventStore;
let sqlStore: AgentEventSqliteStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l2-event-sourcing-"));
  memStore = new AgentEventStore();
  sqlStore = new AgentEventSqliteStore(join(tmpDir, "events.db"));
});

afterEach(() => {
  sqlStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addTradeEvent(
  store: AgentEventStore | AgentEventSqliteStore,
  title: string,
  detail: string,
  opts: { type?: AgentEventType; status?: "completed" | "pending" } = {},
): AgentEvent {
  return store.addEvent({
    type: opts.type ?? "trade_executed",
    title,
    detail,
    status: opts.status ?? "completed",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
describe("Event Sourcing — In-Memory Store", () => {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. Event creation generates unique ID and timestamp
  // ═══════════════════════════════════════════════════════════════════════

  it("creates events with unique IDs and timestamps", () => {
    const evt1 = addTradeEvent(memStore, "Buy BTC", "0.1 BTC @ 50000");
    const evt2 = addTradeEvent(memStore, "Sell ETH", "1 ETH @ 3000");

    expect(evt1.id).not.toBe(evt2.id);
    expect(evt1.timestamp).toBeGreaterThan(0);
    expect(evt2.timestamp).toBeGreaterThanOrEqual(evt1.timestamp);
    expect(evt1.type).toBe("trade_executed");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Events are queryable by type
  // ═══════════════════════════════════════════════════════════════════════

  it("filters events by type", () => {
    addTradeEvent(memStore, "Trade 1", "detail", { type: "trade_executed" });
    addTradeEvent(memStore, "Alert 1", "detail", { type: "alert_triggered" });
    addTradeEvent(memStore, "Trade 2", "detail", { type: "trade_executed" });
    addTradeEvent(memStore, "Promo", "detail", { type: "strategy_promoted" });

    const trades = memStore.listEvents({ type: "trade_executed" });
    expect(trades.length).toBe(2);
    expect(trades.every((e) => e.type === "trade_executed")).toBe(true);

    const alerts = memStore.listEvents({ type: "alert_triggered" });
    expect(alerts.length).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Events are queryable by status
  // ═══════════════════════════════════════════════════════════════════════

  it("filters events by status", () => {
    addTradeEvent(memStore, "Pending Order", "waiting", { status: "pending" });
    addTradeEvent(memStore, "Done Order", "filled", { status: "completed" });

    const pending = memStore.listEvents({ status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0].title).toBe("Pending Order");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Subscriber receives events in real time
  // ═══════════════════════════════════════════════════════════════════════

  it("subscribers receive new events immediately", () => {
    const received: AgentEvent[] = [];
    const unsub = memStore.subscribe((evt) => received.push(evt));

    addTradeEvent(memStore, "Sub Event 1", "detail");
    addTradeEvent(memStore, "Sub Event 2", "detail");

    expect(received.length).toBe(2);
    expect(received[0].title).toBe("Sub Event 1");
    expect(received[1].title).toBe("Sub Event 2");

    unsub();
    addTradeEvent(memStore, "After Unsub", "detail");
    expect(received.length).toBe(2); // no more after unsubscribe
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Multiple subscribers are independent
  // ═══════════════════════════════════════════════════════════════════════

  it("multiple subscribers each receive all events independently", () => {
    const received1: AgentEvent[] = [];
    const received2: AgentEvent[] = [];

    const unsub1 = memStore.subscribe((evt) => received1.push(evt));
    const unsub2 = memStore.subscribe((evt) => received2.push(evt));

    addTradeEvent(memStore, "Shared Event", "detail");

    expect(received1.length).toBe(1);
    expect(received2.length).toBe(1);
    expect(received1[0].id).toBe(received2[0].id);

    unsub1();
    unsub2();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Approve pending event
  // ═══════════════════════════════════════════════════════════════════════

  it("approving a pending event changes its status", () => {
    const evt = addTradeEvent(memStore, "Approval Request", "Needs confirmation", {
      type: "trade_pending",
      status: "pending",
    });

    expect(memStore.pendingCount()).toBe(1);

    const approved = memStore.approve(evt.id);
    expect(approved).toBeDefined();
    expect(approved!.status).toBe("approved");
    expect(memStore.pendingCount()).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Reject pending event with reason
  // ═══════════════════════════════════════════════════════════════════════

  it("rejecting a pending event records the reason", () => {
    const evt = addTradeEvent(memStore, "Risky Trade", "High leverage", {
      type: "trade_pending",
      status: "pending",
    });

    const rejected = memStore.reject(evt.id, "Too risky");
    expect(rejected).toBeDefined();
    expect(rejected!.status).toBe("rejected");

    // A system notification event should be created
    const systemEvents = memStore.listEvents({ type: "system" });
    expect(systemEvents.length).toBe(1);
    expect(systemEvents[0].title).toContain("Rejected");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Approving a non-pending event returns undefined
  // ═══════════════════════════════════════════════════════════════════════

  it("cannot approve a completed event", () => {
    const evt = addTradeEvent(memStore, "Already Done", "filled", { status: "completed" });

    const result = memStore.approve(evt.id);
    expect(result).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Events returned newest first
  // ═══════════════════════════════════════════════════════════════════════

  it("listEvents returns events in reverse chronological order", () => {
    addTradeEvent(memStore, "First", "detail");
    addTradeEvent(memStore, "Second", "detail");
    addTradeEvent(memStore, "Third", "detail");

    const all = memStore.listEvents();
    expect(all[0].title).toBe("Third");
    expect(all[2].title).toBe("First");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Event store handles subscriber errors gracefully
  // ═══════════════════════════════════════════════════════════════════════

  it("subscriber errors do not break event processing", () => {
    const received: AgentEvent[] = [];

    memStore.subscribe(() => {
      throw new Error("Bad subscriber");
    });
    memStore.subscribe((evt) => received.push(evt));

    addTradeEvent(memStore, "Resilient Event", "detail");

    // Second subscriber still received the event
    expect(received.length).toBe(1);
    expect(received[0].title).toBe("Resilient Event");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. Get event by ID
  // ═══════════════════════════════════════════════════════════════════════

  it("retrieves a specific event by ID", () => {
    const evt = addTradeEvent(memStore, "Specific Event", "detail");
    const fetched = memStore.getEvent(evt.id);

    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(evt.id);
    expect(fetched!.title).toBe("Specific Event");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Non-existent event ID returns undefined
  // ═══════════════════════════════════════════════════════════════════════

  it("returns undefined for non-existent event ID", () => {
    const fetched = memStore.getEvent("nonexistent-id");
    expect(fetched).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Event Sourcing — SQLite Persistent Store", () => {
  // ═══════════════════════════════════════════════════════════════════════
  // 13. SQLite store persists and retrieves events
  // ═══════════════════════════════════════════════════════════════════════

  it("persists events to SQLite and retrieves them", () => {
    const evt = sqlStore.addEvent({
      type: "trade_executed",
      title: "Persistent Trade",
      detail: "0.5 ETH @ 3000",
      status: "completed",
    });

    const all = sqlStore.listEvents();
    expect(all.length).toBe(1);
    expect(all[0].title).toBe("Persistent Trade");
    expect(all[0].id).toBe(evt.id);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14. SQLite store filters by type
  // ═══════════════════════════════════════════════════════════════════════

  it("SQLite store filters events by type", () => {
    sqlStore.addEvent({ type: "trade_executed", title: "Trade", detail: "d", status: "completed" });
    sqlStore.addEvent({
      type: "alert_triggered",
      title: "Alert",
      detail: "d",
      status: "completed",
    });
    sqlStore.addEvent({ type: "emergency_stop", title: "Stop", detail: "d", status: "completed" });

    const trades = sqlStore.listEvents({ type: "trade_executed" });
    expect(trades.length).toBe(1);
    expect(trades[0].title).toBe("Trade");

    const all = sqlStore.listEvents();
    expect(all.length).toBe(3);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15. SQLite store survives close and reopen
  // ═══════════════════════════════════════════════════════════════════════

  it("events persist after store close and reopen", () => {
    sqlStore.addEvent({
      type: "strategy_promoted",
      title: "Promoted SMA",
      detail: "L1 → L2",
      status: "completed",
    });
    sqlStore.close();

    // Reopen from same path
    const reopened = new AgentEventSqliteStore(join(tmpDir, "events.db"));
    const events = reopened.listEvents();

    expect(events.length).toBe(1);
    expect(events[0].title).toBe("Promoted SMA");
    expect(events[0].type).toBe("strategy_promoted");

    // Replace sqlStore so afterEach closes the reopened instance (not the already-closed one)
    sqlStore = reopened;
  });
});
