import { describe, expect, it, vi } from "vitest";
import type { CronJob, CronStoreFile } from "../types.js";
import type { CronServiceState } from "./state.js";
import { applyJobResult } from "./timer.js";

function createMockState(jobs: CronJob[] = []): CronServiceState {
  const store: CronStoreFile = { version: 1, jobs };
  return {
    deps: {
      cronEnabled: true,
      nowMs: () => 1_000_000,
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
    store,
    timer: null,
    running: false,
  } as unknown as CronServiceState;
}

function createJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job-1",
    name: "Test Job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
    ...overrides,
  };
}

const BASE_RESULT = { startedAt: 900_000, endedAt: 1_000_000 };

describe("applyJobResult – delivered=true overrides error status (#50170)", () => {
  it("sets lastRunStatus to ok when delivered=true despite status=error", () => {
    const job = createJob();
    const state = createMockState([job]);

    applyJobResult(state, job, {
      ...BASE_RESULT,
      status: "error",
      error: "Warning: Canvas failed",
      delivered: true,
    });

    expect(job.state.lastRunStatus).toBe("ok");
    expect(job.state.lastStatus).toBe("ok");
  });

  it("preserves lastError for diagnostics even when status is downgraded", () => {
    const job = createJob();
    const state = createMockState([job]);

    applyJobResult(state, job, {
      ...BASE_RESULT,
      status: "error",
      error: "Warning: Message failed",
      delivered: true,
    });

    expect(job.state.lastError).toBe("Warning: Message failed");
    expect(job.state.lastDelivered).toBe(true);
    expect(job.state.lastDeliveryStatus).toBe("delivered");
  });

  it("does not increment consecutiveErrors when delivered=true overrides error", () => {
    const job = createJob();
    const state = createMockState([job]);

    applyJobResult(state, job, {
      ...BASE_RESULT,
      status: "error",
      error: "Warning: Canvas failed",
      delivered: true,
    });

    expect(job.state.consecutiveErrors).toBe(0);
  });

  it("still sets status=error when delivered is false", () => {
    const job = createJob();
    const state = createMockState([job]);

    applyJobResult(state, job, {
      ...BASE_RESULT,
      status: "error",
      error: "Agent failed to start",
      delivered: false,
    });

    expect(job.state.lastRunStatus).toBe("error");
    expect(job.state.consecutiveErrors).toBe(1);
  });

  it("still sets status=error when delivered is undefined", () => {
    const job = createJob();
    const state = createMockState([job]);

    applyJobResult(state, job, {
      ...BASE_RESULT,
      status: "error",
      error: "Agent failed to start",
    });

    expect(job.state.lastRunStatus).toBe("error");
    expect(job.state.consecutiveErrors).toBe(1);
  });

  it("passes through ok status unchanged", () => {
    const job = createJob();
    const state = createMockState([job]);

    applyJobResult(state, job, {
      ...BASE_RESULT,
      status: "ok",
      delivered: true,
    });

    expect(job.state.lastRunStatus).toBe("ok");
    expect(job.state.consecutiveErrors).toBe(0);
  });

  it("does not apply error backoff to nextRunAtMs for recurring job when delivered=true overrides error", () => {
    // Use a high-frequency schedule so the backoff (30 s minimum) would
    // exceed the natural interval and push nextRunAtMs out if applied.
    const schedule = { kind: "every" as const, intervalMs: 5_000 };

    const jobError = createJob({ schedule });
    const jobOk = createJob({ id: "test-job-2", schedule });
    const stateError = createMockState([jobError]);
    const stateOk = createMockState([jobOk]);

    applyJobResult(stateError, jobError, {
      ...BASE_RESULT,
      status: "error",
      error: "Warning: Canvas failed",
      delivered: true,
    });

    applyJobResult(stateOk, jobOk, {
      ...BASE_RESULT,
      status: "ok",
      delivered: true,
    });

    // Both should schedule the same natural next run — no backoff on delivered=true.
    expect(jobError.state.nextRunAtMs).toBe(jobOk.state.nextRunAtMs);
  });
});
