// Stall-detection tests cover event-loop-delay-based cron pause/resume logic.
import { describe, expect, it, vi } from "vitest";
import {
  CRON_STALL_EVENT_LOOP_DELAY_MS,
  CRON_STALL_PAUSE_MS,
  createCronStallDetector,
  isCronDispatchPaused,
  resolveCronStallPauseUntil,
  updateCronStallPause,
} from "./stall-detection.js";
import type { Logger } from "./state.js";
import { createCronServiceState } from "./state.js";

function noopLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeState(nowMs: () => number) {
  return createCronServiceState({
    nowMs,
    log: noopLogger(),
    storePath: "/tmp/does-not-matter.sqlite",
    cronEnabled: true,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  });
}

/** A stub delay monitor whose percentile/max readings are controlled by the test. */
function createStubMonitor(initial: { p99Ms?: number; maxMs?: number } = {}) {
  let p99Ms = initial.p99Ms ?? 0;
  let maxMs = initial.maxMs ?? 0;
  return {
    monitor: {
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn(() => {
        p99Ms = 0;
        maxMs = 0;
      }),
      percentile: vi.fn(() => p99Ms * 1_000_000),
      get max() {
        return maxMs * 1_000_000;
      },
    },
    setDelay: (value: { p99Ms?: number; maxMs?: number }) => {
      p99Ms = value.p99Ms ?? p99Ms;
      maxMs = value.maxMs ?? maxMs;
    },
  };
}

describe("resolveCronStallPauseUntil", () => {
  it("does not pause when delay is below threshold", () => {
    const result = resolveCronStallPauseUntil({
      sample: { delayP99Ms: CRON_STALL_EVENT_LOOP_DELAY_MS - 1, delayMaxMs: 0 },
      nowMs: 1_000,
      currentPausedUntil: null,
    });
    expect(result).toBeNull();
  });

  it("triggers a pause at exactly the threshold", () => {
    const nowMs = 1_000;
    const result = resolveCronStallPauseUntil({
      sample: { delayP99Ms: CRON_STALL_EVENT_LOOP_DELAY_MS, delayMaxMs: 0 },
      nowMs,
      currentPausedUntil: null,
    });
    expect(result).toBe(nowMs + CRON_STALL_PAUSE_MS);
  });

  it("triggers a pause above the threshold via delayMaxMs alone", () => {
    const nowMs = 5_000;
    const result = resolveCronStallPauseUntil({
      sample: { delayP99Ms: 0, delayMaxMs: CRON_STALL_EVENT_LOOP_DELAY_MS + 5_000 },
      nowMs,
      currentPausedUntil: null,
    });
    expect(result).toBe(nowMs + CRON_STALL_PAUSE_MS);
  });

  it("uses the exact configured pause duration (300_000ms)", () => {
    const nowMs = 42_000;
    const result = resolveCronStallPauseUntil({
      sample: { delayP99Ms: CRON_STALL_EVENT_LOOP_DELAY_MS * 5, delayMaxMs: 0 },
      nowMs,
      currentPausedUntil: null,
    });
    expect(result).toBe(nowMs + 300_000);
  });

  it("preserves an already-active pause window rather than restarting it", () => {
    const currentPausedUntil = 10_000;
    const result = resolveCronStallPauseUntil({
      sample: { delayP99Ms: CRON_STALL_EVENT_LOOP_DELAY_MS * 3, delayMaxMs: 0 },
      nowMs: 5_000,
      currentPausedUntil,
    });
    expect(result).toBe(currentPausedUntil);
  });

  it("resumes (returns null) once the pause window has elapsed and delay is healthy", () => {
    const currentPausedUntil = 10_000;
    const result = resolveCronStallPauseUntil({
      sample: { delayP99Ms: 0, delayMaxMs: 0 },
      nowMs: 10_001,
      currentPausedUntil,
    });
    expect(result).toBeNull();
  });

  it("respects custom threshold/pause overrides", () => {
    const result = resolveCronStallPauseUntil({
      sample: { delayP99Ms: 500, delayMaxMs: 0 },
      nowMs: 0,
      currentPausedUntil: null,
      thresholdMs: 400,
      pauseMs: 1_234,
    });
    expect(result).toBe(1_234);
  });
});

describe("createCronStallDetector", () => {
  it("samples delay from an injected monitor and resets it after each sample", () => {
    const { monitor, setDelay } = createStubMonitor();
    const detector = createCronStallDetector({ createDelayMonitor: () => monitor });
    setDelay({ p99Ms: 12_000, maxMs: 15_000 });

    const first = detector.sample();
    expect(first).toEqual({ delayP99Ms: 12_000, delayMaxMs: 15_000 });
    // reset() is called once during detector creation and once per sample().
    expect(monitor.reset).toHaveBeenCalledTimes(2);

    setDelay({ p99Ms: 0, maxMs: 0 });
    const second = detector.sample();
    expect(second).toEqual({ delayP99Ms: 0, delayMaxMs: 0 });

    detector.stop();
    expect(monitor.disable).toHaveBeenCalledTimes(1);
  });

  it("falls back to zero-delay samples if the monitor cannot be created", () => {
    const detector = createCronStallDetector({
      createDelayMonitor: () => {
        throw new Error("unsupported");
      },
    });
    expect(detector.sample()).toEqual({ delayP99Ms: 0, delayMaxMs: 0 });
  });
});

describe("updateCronStallPause + isCronDispatchPaused (integration)", () => {
  it("does not pause cron dispatch when delay stays below threshold", () => {
    const nowMs = 0;
    const state = makeState(() => nowMs);
    const { monitor } = createStubMonitor({ p99Ms: 100, maxMs: 100 });
    state.stallDetector = createCronStallDetector({ createDelayMonitor: () => monitor });

    updateCronStallPause(state);

    expect(state.pausedUntil).toBeNull();
    expect(isCronDispatchPaused(state, nowMs)).toBe(false);
  });

  it("pauses cron dispatch for exactly 300_000ms when the stall threshold is met", () => {
    const nowMs = 1_000_000;
    const state = makeState(() => nowMs);
    const { monitor, setDelay } = createStubMonitor();
    state.stallDetector = createCronStallDetector({ createDelayMonitor: () => monitor });
    setDelay({ p99Ms: CRON_STALL_EVENT_LOOP_DELAY_MS + 2_000, maxMs: 0 });

    updateCronStallPause(state);

    expect(state.pausedUntil).toBe(nowMs + CRON_STALL_PAUSE_MS);
    expect(isCronDispatchPaused(state, nowMs)).toBe(true);
    // Still paused just before the window elapses.
    expect(isCronDispatchPaused(state, state.pausedUntil! - 1)).toBe(true);
  });

  it("resumes cron dispatch automatically once the pause window elapses", () => {
    let nowMs = 0;
    const state = makeState(() => nowMs);
    const { monitor, setDelay } = createStubMonitor();
    state.stallDetector = createCronStallDetector({ createDelayMonitor: () => monitor });
    setDelay({ p99Ms: CRON_STALL_EVENT_LOOP_DELAY_MS + 1_000, maxMs: 0 });

    updateCronStallPause(state);
    expect(isCronDispatchPaused(state, nowMs)).toBe(true);
    const pausedUntil = state.pausedUntil as number;

    // Advance time to just after the window elapses and let the loop recover.
    nowMs = pausedUntil + 1;
    setDelay({ p99Ms: 0, maxMs: 0 });
    updateCronStallPause(state);

    expect(state.pausedUntil).toBeNull();
    expect(isCronDispatchPaused(state, nowMs)).toBe(false);
  });

  it("keeps the original pause window active on a re-check tick within the window", () => {
    let nowMs = 0;
    const state = makeState(() => nowMs);
    const { monitor, setDelay } = createStubMonitor();
    state.stallDetector = createCronStallDetector({ createDelayMonitor: () => monitor });
    setDelay({ p99Ms: CRON_STALL_EVENT_LOOP_DELAY_MS + 1_000, maxMs: 0 });

    updateCronStallPause(state);
    const pausedUntil = state.pausedUntil as number;

    nowMs = 1_000;
    setDelay({ p99Ms: 0, maxMs: 0 });
    updateCronStallPause(state);

    expect(state.pausedUntil).toBe(pausedUntil);
  });
});
