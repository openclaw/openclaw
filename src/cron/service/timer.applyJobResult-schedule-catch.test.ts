import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { applyJobResult } from "./timer.js";

function createMockState(jobs: CronJob[]): CronServiceState {
  return {
    deps: {
      cronEnabled: true,
      nowMs: () => Date.now(),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runHeartbeatOnce: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      onEvent: vi.fn(),
      persistence: {
        read: vi.fn(),
        write: vi.fn(),
      },
    },
    store: { version: 1, jobs },
    timer: null,
    running: false,
  } as unknown as CronServiceState;
}

function createJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job-1",
    name: "Test Job",
    enabled: true,
    createdAtMs: Date.now() - 100_000,
    updatedAtMs: Date.now() - 100_000,
    schedule: { kind: "cron", expr: "0 * * * *" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
    ...overrides,
  };
}

describe("applyJobResult MIN_REFIRE_GAP for every-schedule jobs (#52097)", () => {
  // Regression: for "every"-schedule jobs, the computed nextRunAtMs could
  // land at or before `endedAt` because the "every" branch did not enforce
  // MIN_REFIRE_GAP_MS.  The timer then picks the job up again immediately,
  // causing repeated spurious executions.

  const now = new Date("2025-06-01T04:57:00.000Z").getTime();
  const DAILY_MS = 86_400_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T04:57:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces minimum refire gap on every-schedule when lastRunAtMs + everyMs lands at endedAt", () => {
    // When lastRunAtMs is exactly one interval ago, nextFromLastRun
    // equals endedAt.  Without MIN_REFIRE_GAP the job becomes
    // immediately due, causing a tight refire loop.
    const job = createJob({
      id: "daily-every",
      name: "Daily Every Job",
      schedule: { kind: "every", everyMs: DAILY_MS, anchorMs: now - 2 * DAILY_MS },
      // lastRunAtMs exactly one interval before endedAt
      state: { lastRunAtMs: now - DAILY_MS, runningAtMs: now - 1000 },
    });
    const state = createMockState([job]);

    const startedAt = now - 1000;
    const endedAt = now;

    applyJobResult(state, job, { status: "ok", startedAt, endedAt });

    // The next run must be strictly after endedAt (with at least
    // MIN_REFIRE_GAP_MS = 2000ms buffer), not at or before endedAt.
    expect(job.state.nextRunAtMs).toBeDefined();
    expect(job.state.nextRunAtMs).toBeGreaterThan(endedAt + 1999);
  });

  it("enforces minimum refire gap on short-interval every-schedule when execution exceeds interval", () => {
    // Edge case: a short "every" interval (5s) where the job execution
    // takes longer than the interval. lastRunAtMs + everyMs <= endedAt,
    // so computeJobNextRunAtMs falls through to anchor-based computation
    // which can return a time at or very near endedAt.
    const SHORT_INTERVAL_MS = 5_000;
    const anchorMs = now - 100 * SHORT_INTERVAL_MS;
    const job = createJob({
      id: "every-short",
      name: "Short Interval Job",
      schedule: { kind: "every", everyMs: SHORT_INTERVAL_MS, anchorMs },
      // Job started 10s ago (longer than 5s interval), so
      // lastRunAtMs + everyMs = (now - 10000) + 5000 = now - 5000 < endedAt
      state: { lastRunAtMs: now - 10_000, runningAtMs: now - 10_000 },
    });
    const state = createMockState([job]);

    const startedAt = now - 10_000;
    const endedAt = now;

    // Normal timer-triggered run (no preserveSchedule).
    applyJobResult(state, job, { status: "ok", startedAt, endedAt });

    // nextRunAtMs must be at least MIN_REFIRE_GAP_MS after endedAt to
    // prevent a tight refire loop.
    expect(job.state.nextRunAtMs).toBeDefined();
    expect(job.state.nextRunAtMs).toBeGreaterThan(endedAt + 1999);
  });
});
