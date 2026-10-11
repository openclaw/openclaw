// Tests heartbeat event emission and listener cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitHeartbeatEvent,
  emitLegacyHeartbeatCronOutcome,
  getLastHeartbeatEvent,
  onHeartbeatEvent,
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

  it("adds a delivery-disabled message to target-none events without changing the reason", () => {
    const listener = vi.fn();
    const unsubscribe = onHeartbeatEvent(listener);

    emitHeartbeatEvent({ status: "skipped", reason: "target-none" });

    const expected = {
      ts: 1767960000000,
      status: "skipped",
      reason: "target-none",
      message: "Proactive automation delivery is disabled.",
    };
    expect(getLastHeartbeatEvent()).toEqual(expected);
    expect(listener).toHaveBeenCalledWith(expected);

    unsubscribe();
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
        "Proactive automation has no delivery route. Configure its delivery in Automations; run openclaw doctor --fix for legacy configuration.",
    });
  });

  it.each([
    {
      completionStatus: "failed" as const,
      deliveryError: "owner route unavailable",
      expected: "failed",
    },
    { completionStatus: "unknown" as const, expected: "skipped" },
    {
      status: "skipped" as const,
      completionStatus: "failed" as const,
      expected: "skipped",
    },
    {
      status: "skipped" as const,
      completionStatus: "failed" as const,
      deliveryError: "delivery failed before cancellation",
      expected: "failed",
    },
    {
      completionStatus: "succeeded" as const,
      deliveryError: "Owner delivery unavailable (no-route)",
      expected: "failed",
    },
    {
      completionStatus: "succeeded" as const,
      deliverySuppressionReason: "silent" as const,
      expected: "ok-empty",
    },
  ])("projects canonical $completionStatus without inventing delivery success", (outcome) => {
    emitLegacyHeartbeatCronOutcome({
      action: "finished",
      jobId: "converted",
      status: "ok",
      delivered: false,
      ...outcome,
    });
    expect(getLastHeartbeatEvent()).toMatchObject({ status: outcome.expected, silent: true });
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

  it("shares heartbeat state across duplicate module instances", async () => {
    const first = await importHeartbeatEventsModule(`first-${Date.now()}`);
    const second = await importHeartbeatEventsModule(`second-${Date.now()}`);

    first.resetHeartbeatEventsForTest();

    const seen: string[] = [];
    const stop = first.onHeartbeatEvent((evt) => {
      seen.push(evt.status);
    });

    second.emitHeartbeatEvent({ status: "ok-token", preview: "pong" });

    expect(first.getLastHeartbeatEvent()).toEqual({
      ts: 1767960000000,
      status: "ok-token",
      preview: "pong",
    });
    expect(seen).toEqual(["ok-token"]);

    stop();
    first.resetHeartbeatEventsForTest();
  });
});
