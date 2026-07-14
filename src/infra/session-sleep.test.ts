import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelSessionSleep,
  clearSessionSleeps,
  hasPendingSessionSleep,
  scheduleSessionSleep,
} from "./session-sleep.js";

describe("session sleep registry", () => {
  afterEach(() => {
    clearSessionSleeps();
    vi.useRealTimers();
  });

  it("fires once and removes the pending timer", async () => {
    vi.useFakeTimers();
    const onWake = vi.fn();
    scheduleSessionSleep({ sessionKey: "agent:main:one", delayMs: 1_000, onWake });

    expect(hasPendingSessionSleep("agent:main:one")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onWake).toHaveBeenCalledOnce();
    expect(hasPendingSessionSleep("agent:main:one")).toBe(false);
  });

  it("replaces an older timer for the same session", async () => {
    vi.useFakeTimers();
    const firstWake = vi.fn();
    const secondWake = vi.fn();
    scheduleSessionSleep({ sessionKey: "agent:main:one", delayMs: 1_000, onWake: firstWake });
    scheduleSessionSleep({ sessionKey: "agent:main:one", delayMs: 2_000, onWake: secondWake });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(firstWake).not.toHaveBeenCalled();
    expect(secondWake).toHaveBeenCalledOnce();
  });

  it("cancels a pending timer without waking", async () => {
    vi.useFakeTimers();
    const onWake = vi.fn();
    scheduleSessionSleep({ sessionKey: "agent:main:one", delayMs: 1_000, onWake });

    expect(cancelSessionSleep("agent:main:one")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onWake).not.toHaveBeenCalled();
  });

  it("clears all timers as gateway shutdown would", async () => {
    vi.useFakeTimers();
    const onWake = vi.fn();
    scheduleSessionSleep({ sessionKey: "agent:main:one", delayMs: 1_000, onWake });
    scheduleSessionSleep({ sessionKey: "agent:main:two", delayMs: 1_000, onWake });

    clearSessionSleeps();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onWake).not.toHaveBeenCalled();
    expect(hasPendingSessionSleep("agent:main:one")).toBe(false);
    expect(hasPendingSessionSleep("agent:main:two")).toBe(false);
  });

  it("reports asynchronous wake failures and still clears the timer", async () => {
    vi.useFakeTimers();
    const error = new Error("wake failed");
    const onError = vi.fn();
    scheduleSessionSleep({
      sessionKey: "agent:main:one",
      delayMs: 1_000,
      onWake: async () => {
        throw error;
      },
      onError,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(onError).toHaveBeenCalledWith(error);
    expect(hasPendingSessionSleep("agent:main:one")).toBe(false);
  });
});
