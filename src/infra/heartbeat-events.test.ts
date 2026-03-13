import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitHeartbeatEvent,
  getLastHeartbeatEvent,
  onHeartbeatEvent,
  resolveIndicatorType,
} from "./heartbeat-events.js";

describe("resolveIndicatorType", () => {
  it("maps heartbeat statuses to indicator types", () => {
    expect(resolveIndicatorType("ok-empty")).toBe("ok");
    expect(resolveIndicatorType("ok-token")).toBe("ok");
    expect(resolveIndicatorType("sent")).toBe("alert");
    expect(resolveIndicatorType("failed")).toBe("error");
    expect(resolveIndicatorType("skipped")).toBeUndefined();
  });
});

describe("heartbeat events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores the last event and timestamps emitted payloads", () => {
    emitHeartbeatEvent({ status: "sent", to: "+123", preview: "ping" });

    expect(getLastHeartbeatEvent()).toEqual({
      ts: 1767960000000,
      status: "sent",
      to: "+123",
      preview: "ping",
    });
  });

  it("delivers events to listeners, isolates listener failures, and supports unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribeFirst = onHeartbeatEvent((evt) => {
      seen.push(`first:${evt.status}`);
    });
    onHeartbeatEvent(() => {
      throw new Error("boom");
    });
    const unsubscribeThird = onHeartbeatEvent((evt) => {
      seen.push(`third:${evt.status}`);
    });

    emitHeartbeatEvent({ status: "ok-empty" });
    unsubscribeFirst();
    unsubscribeThird();
    emitHeartbeatEvent({ status: "failed" });

    expect(seen).toEqual(["first:ok-empty", "third:ok-empty"]);
  });
});
