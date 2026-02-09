import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCronServiceState } from "./service/state.js";
import { startAntiZombieWatchdog } from "./service/timer.js";
import { type CronJob, type CronStoreFile } from "./types.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("cron anti-zombie watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-initializes the scheduler when no tick completes within 60s", () => {
    const now = Date.now();
    const state = createCronServiceState({
      storePath: "/tmp/cron-jobs.json",
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    const job: CronJob = {
      id: "job-1",
      name: "test",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now + 60_000).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
      state: { nextRunAtMs: now + 60_000 },
    };

    const store: CronStoreFile = {
      version: 1,
      jobs: [job],
    };

    state.store = store;
    state.lastTimerTickAtMs = now - 61_000; // simulate idle scheduler

    expect(state.timer).toBeNull();

    startAntiZombieWatchdog(state);

    // Fire the anti-zombie interval once.
    vi.advanceTimersByTime(60_000);

    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        thresholdMs: 60_000,
      }),
      expect.stringContaining("cron: anti-zombie: no tick in 60s, re-initializing scheduler"),
    );

    expect(state.timer).not.toBeNull();
  });

  it("does not trigger when a recent tick has completed", () => {
    const now = Date.now();
    const state = createCronServiceState({
      storePath: "/tmp/cron-jobs.json",
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    const job: CronJob = {
      id: "job-1",
      name: "test",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now + 60_000).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
      state: { nextRunAtMs: now + 60_000 },
    };

    const store: CronStoreFile = {
      version: 1,
      jobs: [job],
    };

    state.store = store;
    state.lastTimerTickAtMs = now; // last tick just completed

    startAntiZombieWatchdog(state);

    vi.advanceTimersByTime(60_000);

    expect(noopLogger.warn).not.toHaveBeenCalled();
  });
});
