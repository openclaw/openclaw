import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resolveIndicatorType,
  emitHeartbeatEvent,
  onHeartbeatEvent,
  getLastHeartbeatEvent,
} from "./heartbeat-events.js";

describe("resolveIndicatorType", () => {
  it("maps ok-empty to ok", () => {
    expect(resolveIndicatorType("ok-empty")).toBe("ok");
  });

  it("maps ok-token to ok", () => {
    expect(resolveIndicatorType("ok-token")).toBe("ok");
  });

  it("maps sent to alert", () => {
    expect(resolveIndicatorType("sent")).toBe("alert");
  });

  it("maps failed to error", () => {
    expect(resolveIndicatorType("failed")).toBe("error");
  });

  it("maps skipped to undefined", () => {
    expect(resolveIndicatorType("skipped")).toBeUndefined();
  });
});

describe("heartbeat event emitter", () => {
  it("emits events to listeners", () => {
    const listener = vi.fn();
    const unsub = onHeartbeatEvent(listener);
    emitHeartbeatEvent({ status: "sent", to: "test" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toMatchObject({ status: "sent", to: "test" });
    expect(listener.mock.calls[0][0].ts).toBeTypeOf("number");
    unsub();
  });

  it("unsubscribes correctly", () => {
    const listener = vi.fn();
    const unsub = onHeartbeatEvent(listener);
    unsub();
    emitHeartbeatEvent({ status: "ok-empty" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("stores last heartbeat", () => {
    emitHeartbeatEvent({ status: "failed", reason: "timeout" });
    const last = getLastHeartbeatEvent();
    expect(last).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("tolerates listener errors", () => {
    const badListener = vi.fn(() => {
      throw new Error("boom");
    });
    const goodListener = vi.fn();
    const unsub1 = onHeartbeatEvent(badListener);
    const unsub2 = onHeartbeatEvent(goodListener);
    emitHeartbeatEvent({ status: "sent" });
    expect(goodListener).toHaveBeenCalledOnce();
    unsub1();
    unsub2();
  });
});
