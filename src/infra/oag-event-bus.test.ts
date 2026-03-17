import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    watch: vi.fn(() => ({ close: vi.fn() })),
    readFileSync: vi.fn(() => '{"congested": false}'),
  },
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

const {
  emitOagEvent,
  onOagEvent,
  onceOagEvent,
  getOagEventListenerCount,
  resetOagEventBus,
  getCachedHealthSnapshot,
  startFileWatcher,
} = await import("./oag-event-bus.js");

describe("oag-event-bus", () => {
  beforeEach(() => {
    resetOagEventBus();
  });

  it("emits and receives events", () => {
    const handler = vi.fn();
    onOagEvent(handler);
    emitOagEvent("channel_state_changed", { channel: "telegram" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("channel_state_changed");
    expect(handler.mock.calls[0][0].data).toEqual({ channel: "telegram" });
  });

  it("supports unsubscribe", () => {
    const handler = vi.fn();
    const unsub = onOagEvent(handler);
    unsub();
    emitOagEvent("channel_state_changed");
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports once-style listeners", () => {
    const handler = vi.fn();
    onceOagEvent("user_note_pending", handler);
    emitOagEvent("channel_state_changed");
    expect(handler).not.toHaveBeenCalled();
    emitOagEvent("user_note_pending", { note: "test" });
    expect(handler).toHaveBeenCalledTimes(1);
    emitOagEvent("user_note_pending", { note: "again" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("tracks listener count", () => {
    expect(getOagEventListenerCount()).toBe(0);
    const unsub1 = onOagEvent(() => {});
    const unsub2 = onOagEvent(() => {});
    expect(getOagEventListenerCount()).toBe(2);
    unsub1();
    expect(getOagEventListenerCount()).toBe(1);
    unsub2();
    expect(getOagEventListenerCount()).toBe(0);
  });

  it("resets all listeners", () => {
    onOagEvent(() => {});
    onOagEvent(() => {});
    resetOagEventBus();
    expect(getOagEventListenerCount()).toBe(0);
  });

  it("returns null when no snapshot is cached", () => {
    expect(getCachedHealthSnapshot()).toBeNull();
  });

  it("emits incident_recorded events", () => {
    const handler = vi.fn();
    onOagEvent(handler);
    emitOagEvent("incident_recorded", { type: "channel_crash_loop", channel: "telegram" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("incident_recorded");
    expect(handler.mock.calls[0][0].data).toEqual({
      type: "channel_crash_loop",
      channel: "telegram",
    });
  });

  it("emits evolution_reverted events", () => {
    const handler = vi.fn();
    onOagEvent(handler);
    emitOagEvent("evolution_reverted", {
      parameter: "gateway.oag.delivery.recoveryBudgetMs",
      reason: "regression",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("evolution_reverted");
  });

  it("emits evolution_confirmed events", () => {
    const handler = vi.fn();
    onOagEvent(handler);
    emitOagEvent("evolution_confirmed", { parameter: "gateway.oag.delivery.recoveryBudgetMs" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("evolution_confirmed");
  });

  it("emits diagnosis_completed events", () => {
    const handler = vi.fn();
    onOagEvent(handler);
    emitOagEvent("diagnosis_completed", { diagnosisId: "diag-123" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("diagnosis_completed");
  });

  it("emits metrics_snapshot events", () => {
    const handler = vi.fn();
    onOagEvent(handler);
    emitOagEvent("metrics_snapshot", { uptimeMs: 60000 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("metrics_snapshot");
  });

  it("returns a deep clone so mutations do not affect the cache", () => {
    // startFileWatcher triggers an initial read which populates cachedSnapshot
    startFileWatcher("/tmp/fake-state.json", () => {});
    const snapshot1 = getCachedHealthSnapshot();
    expect(snapshot1).not.toBeNull();
    // Mutate the returned snapshot
    snapshot1!.injectedField = "should not leak";
    snapshot1!.congested = true;
    // Fetch again — should not reflect the mutation
    const snapshot2 = getCachedHealthSnapshot();
    expect(snapshot2).not.toBeNull();
    expect(snapshot2!.injectedField).toBeUndefined();
    expect(snapshot2!.congested).toBe(false);
  });
});
