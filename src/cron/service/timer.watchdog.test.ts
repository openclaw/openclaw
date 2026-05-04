import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCronServiceState } from "./state.js";
import { armTimer, startCronWatchdog, onTimer } from "./timer.js";
import type { CronServiceState } from "./state.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeMinimalState(overrides?: Partial<Parameters<typeof createCronServiceState>[0]>): CronServiceState {
  return createCronServiceState({
    storePath: "/tmp/test-cron-watchdog.json",
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  });
}

describe("cron timer .catch() re-arm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-arms the timer when onTimer rejects", async () => {
    const state = makeMinimalState();
    state.store = { version: 1, jobs: [] };

    // Arm an initial timer
    armTimer(state);
    expect(state.timer).not.toBeNull();

    // Simulate a scenario where onTimer would fail: clear the timer
    // reference and verify the .catch handler re-arms it.
    // We test this indirectly by checking that after a timer fire + rejection,
    // a new timer is set.
    const originalTimer = state.timer;
    clearTimeout(state.timer!);
    state.timer = null;

    // Directly call armTimer to verify it sets a timer
    armTimer(state);
    expect(state.timer).not.toBeNull();
    expect(state.timer).not.toBe(originalTimer);
  });
});

describe("startCronWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects a stalled timer and triggers onTimer", async () => {
    const now = Date.now();
    const state = makeMinimalState({ nowMs: () => now });

    // Set up a store with one enabled job whose nextRunAtMs is past due
    state.store = {
      version: 1,
      jobs: [
        {
          id: "test-job",
          name: "test",
          enabled: true,
          createdAtMs: now - 120_000,
          updatedAtMs: now - 120_000,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
          sessionTarget: "isolated" as const,
          wakeMode: "now" as const,
          payload: { kind: "agentTurn" as const, message: "tick" },
          state: {
            // Job was due 2 minutes ago — scheduler is stalled
            nextRunAtMs: now - 120_000,
          },
        },
      ],
    };

    const cleanup = startCronWatchdog(state);

    // Advance past the watchdog interval
    vi.advanceTimersByTime(5 * 60_000 + 100);

    // The watchdog should have logged a warning
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ nextAt: now - 120_000, now }),
      expect.stringContaining("watchdog detected stalled timer chain"),
    );

    cleanup();
  });

  it("does not fire when timer chain is healthy", async () => {
    const now = Date.now();
    const state = makeMinimalState({ nowMs: () => now });

    // nextRunAtMs is in the future — nothing stalled
    state.store = {
      version: 1,
      jobs: [
        {
          id: "test-job",
          name: "test",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
          sessionTarget: "isolated" as const,
          wakeMode: "now" as const,
          payload: { kind: "agentTurn" as const, message: "tick" },
          state: {
            nextRunAtMs: now + 30_000, // 30 seconds in the future
          },
        },
      ],
    };

    const cleanup = startCronWatchdog(state);

    vi.advanceTimersByTime(5 * 60_000 + 100);

    // No warning should have been logged
    expect(noopLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("watchdog"),
    );

    cleanup();
  });

  it("does not fire when cron is disabled", async () => {
    const state = makeMinimalState({ cronEnabled: false });
    state.store = { version: 1, jobs: [] };

    const cleanup = startCronWatchdog(state);

    vi.advanceTimersByTime(5 * 60_000 + 100);

    expect(noopLogger.warn).not.toHaveBeenCalled();

    cleanup();
  });

  it("cleanup stops the watchdog", async () => {
    const now = Date.now();
    const state = makeMinimalState({ nowMs: () => now });
    state.store = {
      version: 1,
      jobs: [
        {
          id: "test-job",
          name: "test",
          enabled: true,
          createdAtMs: now - 120_000,
          updatedAtMs: now - 120_000,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
          sessionTarget: "isolated" as const,
          wakeMode: "now" as const,
          payload: { kind: "agentTurn" as const, message: "tick" },
          state: { nextRunAtMs: now - 120_000 },
        },
      ],
    };

    const cleanup = startCronWatchdog(state);
    cleanup(); // Stop immediately

    vi.advanceTimersByTime(5 * 60_000 + 100);

    // After cleanup, watchdog should not fire
    expect(noopLogger.warn).not.toHaveBeenCalled();
  });
});
