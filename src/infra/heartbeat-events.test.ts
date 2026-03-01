import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_HISTORY_MAX,
  clearHeartbeatEventHistory,
  emitHeartbeatEvent,
  getHeartbeatEventHistory,
  getLastHeartbeatEvent,
} from "./heartbeat-events.js";

describe("heartbeat event history", () => {
  afterEach(() => {
    clearHeartbeatEventHistory();
  });

  it("returns empty array initially", () => {
    expect(getHeartbeatEventHistory()).toEqual([]);
  });

  it("records events in chronological order", () => {
    emitHeartbeatEvent({ status: "sent", durationMs: 100 });
    emitHeartbeatEvent({ status: "ok-empty", durationMs: 50 });
    emitHeartbeatEvent({ status: "failed", reason: "timeout", durationMs: 200 });

    const history = getHeartbeatEventHistory();
    expect(history).toHaveLength(3);
    expect(history[0].status).toBe("sent");
    expect(history[1].status).toBe("ok-empty");
    expect(history[2].status).toBe("failed");
  });

  it("enriches events with a timestamp", () => {
    emitHeartbeatEvent({ status: "sent", durationMs: 100 });

    const history = getHeartbeatEventHistory();
    expect(history[0].ts).toBeTypeOf("number");
    expect(history[0].ts).toBeGreaterThan(0);
  });

  it("caps history at HEARTBEAT_HISTORY_MAX", () => {
    for (let i = 0; i < HEARTBEAT_HISTORY_MAX + 20; i++) {
      emitHeartbeatEvent({ status: "sent", durationMs: i });
    }

    const history = getHeartbeatEventHistory();
    expect(history).toHaveLength(HEARTBEAT_HISTORY_MAX);
    // Oldest entries are pruned; the first remaining should be event #20
    expect(history[0].durationMs).toBe(20);
  });

  it("getHeartbeatEventHistory returns last N with limit", () => {
    emitHeartbeatEvent({ status: "sent", durationMs: 1 });
    emitHeartbeatEvent({ status: "ok-token", durationMs: 2 });
    emitHeartbeatEvent({ status: "failed", reason: "err", durationMs: 3 });
    emitHeartbeatEvent({ status: "skipped", reason: "dup", durationMs: 4 });

    const last2 = getHeartbeatEventHistory(2);
    expect(last2).toHaveLength(2);
    expect(last2[0].durationMs).toBe(3);
    expect(last2[1].durationMs).toBe(4);
  });

  it("getHeartbeatEventHistory returns empty for zero or negative limit", () => {
    emitHeartbeatEvent({ status: "sent", durationMs: 1 });
    emitHeartbeatEvent({ status: "sent", durationMs: 2 });

    expect(getHeartbeatEventHistory(0)).toEqual([]);
    expect(getHeartbeatEventHistory(-1)).toEqual([]);
    expect(getHeartbeatEventHistory(-100)).toEqual([]);
  });

  it("getHeartbeatEventHistory returns all when limit exceeds size", () => {
    emitHeartbeatEvent({ status: "sent", durationMs: 1 });
    emitHeartbeatEvent({ status: "sent", durationMs: 2 });

    const result = getHeartbeatEventHistory(100);
    expect(result).toHaveLength(2);
  });

  it("getHeartbeatEventHistory returns all when no limit provided", () => {
    emitHeartbeatEvent({ status: "sent", durationMs: 1 });
    emitHeartbeatEvent({ status: "sent", durationMs: 2 });
    emitHeartbeatEvent({ status: "sent", durationMs: 3 });

    const result = getHeartbeatEventHistory();
    expect(result).toHaveLength(3);
  });

  it("clearHeartbeatEventHistory resets all state", () => {
    emitHeartbeatEvent({ status: "sent", durationMs: 100 });
    emitHeartbeatEvent({ status: "ok-empty", durationMs: 50 });

    expect(getHeartbeatEventHistory()).toHaveLength(2);
    expect(getLastHeartbeatEvent()).not.toBeNull();

    clearHeartbeatEventHistory();

    expect(getHeartbeatEventHistory()).toHaveLength(0);
    expect(getLastHeartbeatEvent()).toBeNull();
  });

  it("getLastHeartbeatEvent still works alongside history", () => {
    emitHeartbeatEvent({ status: "sent", durationMs: 100 });
    emitHeartbeatEvent({ status: "failed", reason: "err", durationMs: 200 });

    const last = getLastHeartbeatEvent();
    expect(last).not.toBeNull();
    expect(last!.status).toBe("failed");
    expect(last!.durationMs).toBe(200);

    // Should be the same object as the last entry in history
    const history = getHeartbeatEventHistory();
    expect(history[history.length - 1]).toBe(last);
  });
});
