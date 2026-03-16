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

const { emitOagEvent, onOagEvent, onceOagEvent, getOagEventListenerCount, resetOagEventBus } =
  await import("./oag-event-bus.js");

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
});
