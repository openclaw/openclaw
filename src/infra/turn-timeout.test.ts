import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onBriefingEvent,
  resetBriefingEventsForTests,
  type BriefingEvent,
  type BriefingTimeoutEvent,
} from "./briefing-events.js";
import {
  TURN_TIMEOUT_DEFAULT_MS,
  TURN_TIMEOUT_MAX_MS,
  TURN_TIMEOUT_MIN_MS,
  hasTurnTimeoutFired,
  resetTurnTimeoutForTests,
  resolveMaxTurnMs,
  startTurnTimeout,
} from "./turn-timeout.js";

const SESSION_KEY = "agent:ghost:main";
const CHANNEL = "telegram";

function captureBriefings() {
  const events: BriefingEvent[] = [];
  const timeouts: BriefingTimeoutEvent[] = [];
  onBriefingEvent((event) => {
    events.push(event);
    if (event.type === "briefing.timeout") {
      timeouts.push(event);
    }
  });
  return { events, timeouts };
}

describe("resolveMaxTurnMs", () => {
  it("prefers a valid channel value, clamped to min/max", () => {
    expect(resolveMaxTurnMs(7_000)).toEqual({ maxTurnMs: 7_000, source: "channel" });
    expect(resolveMaxTurnMs(TURN_TIMEOUT_MIN_MS - 1)).toEqual({
      maxTurnMs: TURN_TIMEOUT_MIN_MS,
      source: "channel",
    });
    expect(resolveMaxTurnMs(TURN_TIMEOUT_MAX_MS + 1)).toEqual({
      maxTurnMs: TURN_TIMEOUT_MAX_MS,
      source: "channel",
    });
  });

  it("falls back to default when channel value is missing or invalid", () => {
    expect(resolveMaxTurnMs(undefined)).toEqual({
      maxTurnMs: TURN_TIMEOUT_DEFAULT_MS,
      source: "default",
    });
    expect(resolveMaxTurnMs(null)).toEqual({
      maxTurnMs: TURN_TIMEOUT_DEFAULT_MS,
      source: "default",
    });
    expect(resolveMaxTurnMs(0)).toEqual({
      maxTurnMs: TURN_TIMEOUT_DEFAULT_MS,
      source: "default",
    });
    expect(resolveMaxTurnMs(Number.POSITIVE_INFINITY)).toEqual({
      maxTurnMs: TURN_TIMEOUT_DEFAULT_MS,
      source: "default",
    });
    expect(resolveMaxTurnMs(undefined, 9_000)).toEqual({ maxTurnMs: 9_000, source: "default" });
  });

  it("falls back to the hard default if both channel and supplied default are invalid", () => {
    expect(resolveMaxTurnMs(undefined, Number.NaN)).toEqual({
      maxTurnMs: TURN_TIMEOUT_DEFAULT_MS,
      source: "fallback",
    });
  });
});

describe("startTurnTimeout", () => {
  beforeEach(() => {
    resetTurnTimeoutForTests();
    resetBriefingEventsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetTurnTimeoutForTests();
    resetBriefingEventsForTests();
  });

  it("aborts after maxTurnMs and emits exactly one briefing.timeout", () => {
    const captured = captureBriefings();
    const abort = vi.fn();

    const handle = startTurnTimeout({
      sessionKey: SESSION_KEY,
      channel: CHANNEL,
      turnKey: "turn-42",
      maxTurnMs: 5_000,
      abort,
    });

    expect(handle.isFired()).toBe(false);
    expect(handle.isDisposed()).toBe(false);

    vi.advanceTimersByTime(4_999);
    expect(abort).not.toHaveBeenCalled();
    expect(captured.timeouts).toHaveLength(0);

    vi.advanceTimersByTime(2);

    expect(abort).toHaveBeenCalledTimes(1);
    const [info] = abort.mock.calls[0] ?? [];
    expect(info).toMatchObject({
      sessionKey: SESSION_KEY,
      channel: CHANNEL,
      turnKey: "turn-42",
      maxTurnMs: 5_000,
    });
    expect((info as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(5_000);

    expect(captured.timeouts).toHaveLength(1);
    const briefing = captured.timeouts[0];
    expect(briefing).toMatchObject({
      type: "briefing.timeout",
      sessionKey: SESSION_KEY,
      channel: CHANNEL,
      turnKey: "turn-42",
      maxTurnMs: 5_000,
      detail: "abort dispatched",
    });
    expect(handle.isFired()).toBe(true);
    expect(handle.isDisposed()).toBe(true);
    expect(hasTurnTimeoutFired("turn-42")).toBe(true);
  });

  it("dispose() before fire suppresses the abort and the briefing", () => {
    const captured = captureBriefings();
    const abort = vi.fn();

    const handle = startTurnTimeout({
      sessionKey: SESSION_KEY,
      channel: CHANNEL,
      turnKey: "turn-disp",
      maxTurnMs: 3_000,
      abort,
    });
    vi.advanceTimersByTime(1_500);
    handle.dispose();
    vi.advanceTimersByTime(10_000);

    expect(abort).not.toHaveBeenCalled();
    expect(captured.timeouts).toHaveLength(0);
    expect(handle.isFired()).toBe(false);
    expect(handle.isDisposed()).toBe(true);
    // Dispose is idempotent.
    expect(() => handle.dispose()).not.toThrow();
  });

  it("emits briefing.timeout with abort_failed detail when the abort callback throws", () => {
    const captured = captureBriefings();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handle = startTurnTimeout({
      sessionKey: SESSION_KEY,
      channel: CHANNEL,
      turnKey: "turn-boom",
      maxTurnMs: 2_000,
      abort: () => {
        throw new Error("abort exploded");
      },
    });

    vi.advanceTimersByTime(2_000);
    expect(captured.timeouts).toHaveLength(1);
    expect(captured.timeouts[0]?.detail).toMatch(/abort dispatch failed: abort exploded/);
    expect(handle.isFired()).toBe(true);
    errorSpy.mockRestore();
  });

  it("re-arming the same turnKey auto-disposes the previous handle (last-arm wins)", () => {
    const captured = captureBriefings();
    const abortA = vi.fn();
    const abortB = vi.fn();

    const handleA = startTurnTimeout({
      sessionKey: SESSION_KEY,
      channel: CHANNEL,
      turnKey: "turn-retry",
      maxTurnMs: 4_000,
      abort: abortA,
    });
    vi.advanceTimersByTime(1_000);

    const handleB = startTurnTimeout({
      sessionKey: SESSION_KEY,
      channel: CHANNEL,
      turnKey: "turn-retry",
      maxTurnMs: 2_000,
      abort: abortB,
    });

    // Re-arm auto-disposes the previous handle before installing the new one,
    // so the prior closure's timer cannot fire a stale abort/briefing.
    expect(handleA.isDisposed()).toBe(true);
    expect(handleA.isFired()).toBe(false);
    // Manual dispose on the already-disposed previous handle is a no-op.
    expect(() => handleA.dispose()).not.toThrow();

    // Even past the original A deadline, abortA must not run.
    vi.advanceTimersByTime(4_000);

    expect(abortA).not.toHaveBeenCalled();
    expect(abortB).toHaveBeenCalledTimes(1);
    expect(captured.timeouts).toHaveLength(1);
    expect(captured.timeouts[0]?.turnKey).toBe("turn-retry");
    expect(handleB.isFired()).toBe(true);
  });

  it("validates required string inputs and positive maxTurnMs", () => {
    expect(() =>
      startTurnTimeout({
        sessionKey: "",
        channel: CHANNEL,
        turnKey: "t",
        maxTurnMs: 1_000,
        abort: () => {},
      }),
    ).toThrow(/sessionKey/);
    expect(() =>
      startTurnTimeout({
        sessionKey: SESSION_KEY,
        channel: "",
        turnKey: "t",
        maxTurnMs: 1_000,
        abort: () => {},
      }),
    ).toThrow(/channel/);
    expect(() =>
      startTurnTimeout({
        sessionKey: SESSION_KEY,
        channel: CHANNEL,
        turnKey: "",
        maxTurnMs: 1_000,
        abort: () => {},
      }),
    ).toThrow(/turnKey/);
    expect(() =>
      startTurnTimeout({
        sessionKey: SESSION_KEY,
        channel: CHANNEL,
        turnKey: "t",
        maxTurnMs: 0,
        abort: () => {},
      }),
    ).toThrow(/maxTurnMs/);
  });
});
