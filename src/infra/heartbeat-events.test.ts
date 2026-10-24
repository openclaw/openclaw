import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitHeartbeatEvent,
  emitLegacyHeartbeatCronOutcome,
  getLastHeartbeatEvent,
  heartbeatNotifications,
  resetHeartbeatEventsForTest,
} from "./heartbeat-events.js";

type HeartbeatEventsModule = typeof import("./heartbeat-events.js");

const heartbeatEventsModuleUrl = new URL("./heartbeat-events.ts", import.meta.url).href;

async function importHeartbeatEventsModule(cacheBust: string): Promise<HeartbeatEventsModule> {
  return (await import(`${heartbeatEventsModuleUrl}?t=${cacheBust}`)) as HeartbeatEventsModule;
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
    {
      status: "ok" as const,
      completionStatus: "succeeded" as const,
      delivered: true,
      expected: "sent",
    },
    {
      status: "ok" as const,
      completionStatus: "succeeded" as const,
      delivered: false,
      expected: "ok-empty",
    },
    {
      status: "error" as const,
      completionStatus: "failed" as const,
      delivered: false,
      expected: "failed",
    },
    {
      status: "ok" as const,
      completionStatus: "unknown" as const,
      delivered: false,
      expected: "skipped",
    },
  ])(
    "projects receipt settlement into the existing $expected diagnostic",
    ({ expected, ...outcome }) => {
      emitLegacyHeartbeatCronOutcome({
        jobId: "converted",
        action: "finished",
        ...outcome,
        summary: "Synthetic automation result",
        durationMs: 12,
      });
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: expected,
        preview: "Synthetic automation result",
        durationMs: 12,
        silent: !outcome.delivered,
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
  });
});
