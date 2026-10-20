// Tests heartbeat event emission and Gateway callback cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitHeartbeatEvent,
  getLastHeartbeatEvent,
  heartbeatNotifications,
  resetHeartbeatEventsForTest,
  resolveIndicatorType,
} from "./heartbeat-events.js";

type HeartbeatEventsModule = typeof import("./heartbeat-events.js");

const heartbeatEventsModuleUrl = new URL("./heartbeat-events.ts", import.meta.url).href;

async function importHeartbeatEventsModule(cacheBust: string): Promise<HeartbeatEventsModule> {
  return (await import(`${heartbeatEventsModuleUrl}?t=${cacheBust}`)) as HeartbeatEventsModule;
}

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
    resetHeartbeatEventsForTest();
    vi.useRealTimers();
  });

  it("adds a delivery-disabled message to target-none events without changing the reason", () => {
    const listener = vi.fn();
    heartbeatNotifications.onEvent = listener;

    emitHeartbeatEvent({ status: "skipped", reason: "target-none" });

    const expected = {
      ts: 1767960000000,
      status: "skipped",
      reason: "target-none",
      message: "Heartbeat delivery is disabled by configuration (target: none).",
    };
    expect(getLastHeartbeatEvent()).toEqual(expected);
    expect(listener).toHaveBeenCalledWith(expected);

    heartbeatNotifications.onEvent = () => {};
  });

  it("preserves an explicit message for target-none events", () => {
    emitHeartbeatEvent({
      status: "skipped",
      reason: "target-none",
      message: "custom diagnostic",
    });

    expect(getLastHeartbeatEvent()).toMatchObject({
      reason: "target-none",
      message: "custom diagnostic",
    });
  });

  it("adds route setup guidance to no-route events", () => {
    emitHeartbeatEvent({ status: "skipped", reason: "no-route" });

    expect(getLastHeartbeatEvent()).toMatchObject({
      reason: "no-route",
      message:
        "Heartbeat has no delivery route yet. Message your bot once, or set agents.defaults.heartbeat.target.",
    });
  });

  it("delivers events to the Gateway callback and isolates its failures", () => {
    const seen: string[] = [];
    heartbeatNotifications.onEvent = () => {
      throw new Error("boom");
    };
    expect(() => emitHeartbeatEvent({ status: "failed" })).not.toThrow();
    expect(getLastHeartbeatEvent()?.status).toBe("failed");

    heartbeatNotifications.onEvent = (evt) => {
      seen.push(evt.status);
    };
    emitHeartbeatEvent({ status: "ok-empty" });
    heartbeatNotifications.onEvent = () => {};
    emitHeartbeatEvent({ status: "failed" });

    expect(seen).toEqual(["ok-empty"]);
  });

  it("shares heartbeat state across duplicate module instances", async () => {
    const first = await importHeartbeatEventsModule(`first-${Date.now()}`);
    const second = await importHeartbeatEventsModule(`second-${Date.now()}`);

    first.resetHeartbeatEventsForTest();

    const seen: string[] = [];
    first.heartbeatNotifications.onEvent = (evt) => {
      seen.push(evt.status);
    };

    second.emitHeartbeatEvent({ status: "ok-token", preview: "pong" });

    expect(first.getLastHeartbeatEvent()).toEqual({
      ts: 1767960000000,
      status: "ok-token",
      preview: "pong",
    });
    expect(seen).toEqual(["ok-token"]);

    first.resetHeartbeatEventsForTest();
  });
});
