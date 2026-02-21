import { describe, expect, it } from "vitest";
import { recomputeNextRunsForMaintenance } from "./service/jobs.js";
import type { CronServiceState } from "./service/state.js";
import type { CronJob } from "./types.js";

/**
 * Regression tests for https://github.com/openclaw/openclaw/issues/18120
 *
 * When a cron job's session times out or the process crashes mid-execution,
 * `runningAtMs` can persist indefinitely.  The scheduler's stuck-run detection
 * previously used a blanket 2-hour threshold regardless of the job's configured
 * timeout.  A job with a 5-minute timeout would remain blocked for up to
 * 2 hours instead of being unblocked after ~15 minutes.
 *
 * The fix makes stuck detection respect the job's `payload.timeoutSeconds`
 * (plus a 5-minute buffer) so jobs are unblocked promptly.
 */

// Base time: 2026-01-15 12:00:00 UTC
const BASE_TIME_MS = Date.parse("2026-01-15T12:00:00.000Z");

function createMockState(jobs: CronJob[], nowMs: number): CronServiceState {
  return {
    store: { version: 1, jobs },
    running: false,
    timer: null,
    storeLoadedAtMs: nowMs,
    storeFileMtimeMs: null,
    op: Promise.resolve(),
    warnedDisabled: false,
    deps: {
      storePath: "/mock/stuck-test",
      cronEnabled: true,
      nowMs: () => nowMs,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as never,
    },
  };
}

function makeAgentTurnJob(overrides: {
  id: string;
  timeoutSeconds?: number;
  runningAtMs: number;
}): CronJob {
  return {
    id: overrides.id,
    name: `Agent job ${overrides.id}`,
    enabled: true,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "do work",
      timeoutSeconds: overrides.timeoutSeconds,
    },
    createdAtMs: BASE_TIME_MS - 86_400_000,
    updatedAtMs: BASE_TIME_MS - 86_400_000,
    state: {
      nextRunAtMs: BASE_TIME_MS + 3_600_000,
      runningAtMs: overrides.runningAtMs,
    },
  };
}

function makeSystemEventJob(overrides: { id: string; runningAtMs: number }): CronJob {
  return {
    id: overrides.id,
    name: `System job ${overrides.id}`,
    enabled: true,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "check something" },
    createdAtMs: BASE_TIME_MS - 86_400_000,
    updatedAtMs: BASE_TIME_MS - 86_400_000,
    state: {
      nextRunAtMs: BASE_TIME_MS + 3_600_000,
      runningAtMs: overrides.runningAtMs,
    },
  };
}

describe("stuck runningAtMs respects job timeout (#18120)", () => {
  it("clears runningAtMs after job timeout + buffer for agentTurn jobs", () => {
    // 5-minute timeout + 5-minute buffer = 10 min threshold
    // Running for 16 minutes → exceeds threshold → should clear
    const job = makeAgentTurnJob({
      id: "short-timeout-job",
      timeoutSeconds: 300,
      runningAtMs: BASE_TIME_MS - 16 * 60_000,
    });

    const state = createMockState([job], BASE_TIME_MS);
    recomputeNextRunsForMaintenance(state);

    expect(job.state.runningAtMs).toBeUndefined();
  });

  it("does NOT clear runningAtMs while still within timeout + buffer", () => {
    // 5-minute timeout + 5-minute buffer = 10 min threshold
    // Running for 8 minutes → within threshold → should NOT clear
    const runningAt = BASE_TIME_MS - 8 * 60_000;
    const job = makeAgentTurnJob({
      id: "still-running-job",
      timeoutSeconds: 300,
      runningAtMs: runningAt,
    });

    const state = createMockState([job], BASE_TIME_MS);
    recomputeNextRunsForMaintenance(state);

    expect(job.state.runningAtMs).toBe(runningAt);
  });

  it("uses default job timeout for systemEvent jobs (no timeoutSeconds)", () => {
    // systemEvent jobs have no timeoutSeconds → falls back to
    // DEFAULT_JOB_TIMEOUT_MS (10 min) + 5 min buffer = 15 min threshold.
    // Running for 16 minutes → exceeds threshold → should clear
    const job = makeSystemEventJob({
      id: "system-event-stuck",
      runningAtMs: BASE_TIME_MS - 16 * 60_000,
    });

    const state = createMockState([job], BASE_TIME_MS);
    recomputeNextRunsForMaintenance(state);

    expect(job.state.runningAtMs).toBeUndefined();
  });

  it("does NOT clear systemEvent job within default timeout + buffer", () => {
    // DEFAULT_JOB_TIMEOUT_MS (10 min) + 5 min buffer = 15 min threshold.
    // Running for 12 minutes → within threshold → should NOT clear
    const runningAt = BASE_TIME_MS - 12 * 60_000;
    const job = makeSystemEventJob({
      id: "system-event-recent",
      runningAtMs: runningAt,
    });

    const state = createMockState([job], BASE_TIME_MS);
    recomputeNextRunsForMaintenance(state);

    expect(job.state.runningAtMs).toBe(runningAt);
  });

  it("respects long custom timeout on agentTurn jobs", () => {
    // 30-minute timeout + 5-minute buffer = 35 min threshold
    // Running for 25 minutes → within threshold → should NOT clear
    const runningAt = BASE_TIME_MS - 25 * 60_000;
    const job = makeAgentTurnJob({
      id: "long-timeout-job",
      timeoutSeconds: 1800,
      runningAtMs: runningAt,
    });

    const state = createMockState([job], BASE_TIME_MS);
    recomputeNextRunsForMaintenance(state);

    expect(job.state.runningAtMs).toBe(runningAt);
  });

  it("clears long-timeout job once past timeout + buffer", () => {
    // 30-minute timeout + 5-minute buffer = 35 min threshold
    // Running for 36 minutes → exceeds threshold → should clear
    const job = makeAgentTurnJob({
      id: "long-timeout-expired",
      timeoutSeconds: 1800,
      runningAtMs: BASE_TIME_MS - 36 * 60_000,
    });

    const state = createMockState([job], BASE_TIME_MS);
    recomputeNextRunsForMaintenance(state);

    expect(job.state.runningAtMs).toBeUndefined();
  });

  it("falls back to default timeout for agentTurn jobs without timeoutSeconds", () => {
    // agentTurn WITHOUT timeoutSeconds → falls back to
    // DEFAULT_JOB_TIMEOUT_MS (10 min) + 5 min buffer = 15 min threshold.
    // Running for 16 minutes → exceeds threshold → should clear
    const job = makeAgentTurnJob({
      id: "no-timeout-agent",
      // timeoutSeconds intentionally omitted
      runningAtMs: BASE_TIME_MS - 16 * 60_000,
    });

    const state = createMockState([job], BASE_TIME_MS);
    recomputeNextRunsForMaintenance(state);

    expect(job.state.runningAtMs).toBeUndefined();
  });

  it("does NOT clear agentTurn without timeoutSeconds within default threshold", () => {
    // agentTurn WITHOUT timeoutSeconds → 15 min threshold.
    // Running for 12 minutes → within threshold → should NOT clear
    const runningAt = BASE_TIME_MS - 12 * 60_000;
    const job = makeAgentTurnJob({
      id: "no-timeout-recent",
      runningAtMs: runningAt,
    });

    const state = createMockState([job], BASE_TIME_MS);
    recomputeNextRunsForMaintenance(state);

    expect(job.state.runningAtMs).toBe(runningAt);
  });
});
