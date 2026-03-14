/**
 * Regression tests for issue #46341:
 * Recurring cron jobs should retry transient errors (network, timeout, etc.)
 * with exponential backoff instead of waiting until the next natural schedule.
 */
import { describe, expect, it, vi } from "vitest";
import type { CronServiceState } from "./service/state.js";
import { applyJobResult } from "./service/timer.js";
import type { CronJob } from "./types.js";

const NOW_MS = Date.parse("2026-01-01T10:00:00.000Z");
const ENDED_AT = NOW_MS + 500; // job ended 500ms after scheduled time

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeState(cronConfig?: CronServiceState["deps"]["cronConfig"]): CronServiceState {
  return {
    deps: {
      nowMs: () => ENDED_AT,
      log: noopLogger,
      storePath: "/tmp/test",
      cronEnabled: true,
      cronConfig,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    storeLoadedAtMs: null,
    storeFileMtimeMs: null,
  };
}

function makeEveryJob(everyMs: number): CronJob {
  return {
    id: "test-job",
    name: "test",
    enabled: true,
    createdAtMs: NOW_MS - 60_000,
    updatedAtMs: NOW_MS - 60_000,
    schedule: { kind: "every", everyMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    delivery: { mode: "none" },
    state: {},
  };
}

function makeCronJob(cronExpr: string, tz = "UTC"): CronJob {
  return {
    id: "test-cron-job",
    name: "test-cron",
    enabled: true,
    createdAtMs: NOW_MS - 60_000,
    updatedAtMs: NOW_MS - 60_000,
    schedule: { kind: "cron", cron: cronExpr, tz },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    delivery: { mode: "none" },
    state: {},
  };
}

describe("issue #46341: recurring job transient error retry", () => {
  it("retries a transient network error immediately with backoff (not waiting for next schedule)", () => {
    // Daily job: natural next run is ~24 hours away
    const job = makeCronJob("0 10 * * *");
    const state = makeState();

    applyJobResult(state, job, {
      status: "error",
      error: "fetch failed: network error",
      startedAt: NOW_MS,
      endedAt: ENDED_AT,
    });

    // Should retry within backoff window (30s), not wait 24 hours
    const nextRun = job.state.nextRunAtMs!;
    expect(nextRun).toBeGreaterThan(ENDED_AT);
    expect(nextRun).toBeLessThanOrEqual(ENDED_AT + 30_000);
  });

  it("retries a transient timeout error with backoff on a long-interval every-job", () => {
    // Every 60 minutes
    const job = makeEveryJob(60 * 60_000);
    const state = makeState();

    applyJobResult(state, job, {
      status: "error",
      error: "ETIMEDOUT: connection timed out",
      startedAt: NOW_MS,
      endedAt: ENDED_AT,
    });

    const nextRun = job.state.nextRunAtMs!;
    // Should retry within backoff (30s), not wait 60 minutes
    expect(nextRun).toBeLessThanOrEqual(ENDED_AT + 30_000);
  });

  it("retries a 5xx server error with backoff on a recurring job", () => {
    const job = makeEveryJob(10 * 60_000); // every 10 minutes
    const state = makeState();

    applyJobResult(state, job, {
      status: "error",
      error: "upstream returned 503",
      startedAt: NOW_MS,
      endedAt: ENDED_AT,
    });

    const nextRun = job.state.nextRunAtMs!;
    expect(nextRun).toBeLessThanOrEqual(ENDED_AT + 30_000);
  });

  it("does NOT retry early for permanent (non-transient) errors — waits for natural schedule", () => {
    // Every 60 seconds
    const job = makeEveryJob(60_000);
    const state = makeState();

    applyJobResult(state, job, {
      status: "error",
      error: "wrong model id: invalid-model-xyz",
      startedAt: NOW_MS,
      endedAt: ENDED_AT,
    });

    // For a permanent error, next run should be at/after the natural schedule time.
    // For "every" jobs, naturalNext = lastRunAtMs (=startedAt) + everyMs.
    const nextRun = job.state.nextRunAtMs!;
    const naturalNext = NOW_MS + 60_000;
    expect(nextRun).toBeGreaterThanOrEqual(naturalNext);
  });

  it("uses increasing backoff on consecutive transient errors for a daily job", () => {
    const state = makeState();
    const job = makeCronJob("0 10 * * *");

    const recordNext = () => {
      applyJobResult(state, job, {
        status: "error",
        error: "econnreset",
        startedAt: NOW_MS,
        endedAt: ENDED_AT,
      });
      return job.state.nextRunAtMs!;
    };

    const first = recordNext(); // consecutiveErrors → 1, 30s backoff
    const second = recordNext(); // consecutiveErrors → 2, 60s backoff
    const third = recordNext(); // consecutiveErrors → 3, 5min backoff

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    // All well within 5 minutes, not waiting 24 hours
    expect(third).toBeLessThanOrEqual(ENDED_AT + 5 * 60_000);
  });
});
