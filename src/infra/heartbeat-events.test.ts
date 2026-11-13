import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitHeartbeatEvent,
  emitLegacyHeartbeatCronOutcome,
  getLastHeartbeatEvent,
  heartbeatNotifications,
  resetHeartbeatEventsForTest,
} from "./heartbeat-events.js";

type HeartbeatEventsModule = typeof import("./heartbeat-events.js");

async function importHeartbeatEventsModule(cacheBust: string): Promise<HeartbeatEventsModule> {
  return (await import(
    `${new URL("./heartbeat-events.ts", import.meta.url).href}?t=${cacheBust}`
  )) as HeartbeatEventsModule;
}

describe("heartbeat events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T12:00:00Z"));
  });

  afterEach(() => {
    resetHeartbeatEventsForTest();
    vi.useRealTimers();
  });

  it.each([
    ["ok", "succeeded", true, "sent", `${"s".repeat(1999)}😀tail`, "s".repeat(1999)],
    ["ok", "succeeded", false, "ok-empty", `${"s".repeat(1998)}😀`, `${"s".repeat(1998)}😀`],
    ["error", "failed", false, "failed", "result", "result"],
    ["ok", "unknown", false, "skipped", "result", "result"],
  ] as const)(
    "projects receipt settlement (%s, %s, delivered: %s) into %s",
    (status, completionStatus, delivered, expected, summary, preview) => {
      emitLegacyHeartbeatCronOutcome({
        jobId: "converted",
        action: "finished",
        status,
        completionStatus,
        delivered,
        summary,
        durationMs: 12,
      });
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: expected,
        preview,
        durationMs: 12,
        silent: !delivered,
      });
    },
  );

  it.each([
    ["target-none", undefined, "Heartbeat delivery is disabled by configuration (target: none)."],
    ["target-none", "custom diagnostic", "custom diagnostic"],
    [
      "no-route",
      undefined,
      "Heartbeat has no delivery route yet. Message your bot once, or set agents.defaults.heartbeat.target.",
    ],
  ])(
    "enriches %s events while preserving explicit messages (%s)",
    (reason, message, expectedMessage) => {
      const listener = vi.fn();
      heartbeatNotifications.onEvent = listener;
      emitHeartbeatEvent({ status: "skipped", reason, ...(message ? { message } : {}) });
      const expected = {
        ts: 1767960000000,
        status: "skipped",
        reason,
        message: expectedMessage,
      };
      expect(getLastHeartbeatEvent()).toEqual(expected);
      expect(listener).toHaveBeenCalledWith(expected);
    },
  );

  it("shares state and replaceable failure-isolated callbacks across module instances", async () => {
    const first = await importHeartbeatEventsModule(`first-${Date.now()}`);
    const second = await importHeartbeatEventsModule(`second-${Date.now()}`);

    first.resetHeartbeatEventsForTest();
    first.heartbeatNotifications.onEvent = () => {
      throw new Error("boom");
    };
    expect(() => second.emitHeartbeatEvent({ status: "failed" })).not.toThrow();
    expect(first.getLastHeartbeatEvent()?.status).toBe("failed");
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
    first.heartbeatNotifications.onEvent = () => {};
    second.emitHeartbeatEvent({ status: "failed" });
    expect(seen).toEqual(["ok-token"]);
  });
});
