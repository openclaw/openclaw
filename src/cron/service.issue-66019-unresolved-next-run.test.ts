// Next-run regression tests cover unresolved next-run state after service updates.
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultIsolatedRunner,
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import * as schedule from "./schedule.js";
import * as jobs from "./service/jobs.js";
import { createCronServiceState } from "./service/state.js";
import { applyJobResult, onTimer } from "./service/timer.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const issue66019Fixtures = setupCronRegressionFixtures({ prefix: "cron-66019-" });

function createIssue66019Job(params: { id: string; scheduledAt: number }) {
  return createIsolatedRegressionJob({
    id: params.id,
    name: params.id,
    scheduledAt: params.scheduledAt,
    schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
    payload: { kind: "agentTurn", message: "ping" },
    state: { nextRunAtMs: params.scheduledAt - 1_000 },
  });
}

function createIssue66019State(params: {
  storePath: string;
  nowMs: () => number;
  runIsolatedAgentJob: Parameters<typeof createCronServiceState>[0]["runIsolatedAgentJob"];
}) {
  return createCronServiceState({
    cronEnabled: true,
    storePath: params.storePath,
    log: noopLogger,
    nowMs: params.nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
  });
}

function clearCronTimer(state: ReturnType<typeof createCronServiceState>) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

async function expectJobDoesNotRefireWhenNextRunIsUnresolved(params: {
  state: ReturnType<typeof createCronServiceState>;
  runIsolatedAgentJob: unknown;
  advanceNow: () => void;
}) {
  await onTimer(params.state);
  expect(params.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  expect(params.state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();

  params.advanceNow();
  await onTimer(params.state);

  expect(params.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  expect(params.state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();
}

function createEveryUnresolvedFixture(params: {
  id: string;
  scheduledAt: number;
  everyMs?: number;
  invalidEveryMs?: boolean;
  consecutiveErrors?: number;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: params.scheduledAt - 86_400_000,
    updatedAtMs: params.scheduledAt - 86_400_000,
    schedule: {
      kind: "every",
      everyMs: params.invalidEveryMs ? ("abc" as unknown as number) : (params.everyMs ?? 60_000),
    },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "ping" },
    delivery: { mode: "announce" },
    state: {
      nextRunAtMs: params.scheduledAt - 1_000,
      lastRunAtMs: params.scheduledAt - 60_000,
      ...(params.consecutiveErrors !== undefined
        ? { consecutiveErrors: params.consecutiveErrors }
        : {}),
    },
  };
}

function createWarnCapturingState(scheduledAt: number) {
  const warnLogs: Array<{ obj: unknown; msg?: string }> = [];
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: "/dev/null",
    log: {
      ...noopLogger,
      warn: (obj: unknown, msg?: string) => warnLogs.push({ obj, msg }),
    },
    nowMs: () => scheduledAt,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: createDefaultIsolatedRunner(),
  });
  return { state, warnLogs };
}

describe("#66019 unresolved next-run repro", () => {
  it("does not refire a recurring cron job 2s later when next-run resolution returns undefined", async () => {
    const store = issue66019Fixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-04-13T15:40:00.000Z");
    let now = scheduledAt;

    const cronJob = createIssue66019Job({
      id: "cron-66019-minimal-success",
      scheduledAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    const runIsolatedAgentJob = createDefaultIsolatedRunner();
    const nextRunSpy = vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);
    const state = createIssue66019State({
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob,
    });

    try {
      // Before the fix, applyJobResult would synthesize endedAt + 2_000 here,
      // so a second tick a couple seconds later would refire the same job.
      await expectJobDoesNotRefireWhenNextRunIsUnresolved({
        state,
        runIsolatedAgentJob,
        advanceNow: () => {
          now = scheduledAt + 2_001;
        },
      });
    } finally {
      nextRunSpy.mockRestore();
      clearCronTimer(state);
    }
  });

  it("does not refire a recurring errored cron job after the first backoff window when next-run resolution returns undefined", async () => {
    const store = issue66019Fixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-04-13T15:45:00.000Z");
    let now = scheduledAt;

    const cronJob = createIssue66019Job({
      id: "cron-66019-minimal-error",
      scheduledAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "synthetic failure",
    });
    const nextRunSpy = vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);
    const state = createIssue66019State({
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob,
    });

    try {
      // Before the fix, the error branch would synthesize the first backoff
      // retry (30s), so the next tick after that window would rerun the job.
      await expectJobDoesNotRefireWhenNextRunIsUnresolved({
        state,
        runIsolatedAgentJob,
        advanceNow: () => {
          now = scheduledAt + 30_001;
        },
      });
    } finally {
      nextRunSpy.mockRestore();
      clearCronTimer(state);
    }
  });

  it.each([
    {
      name: "error retry with mocked unresolved next run",
      id: "cron-66019-every-error-unresolved",
      scheduledAt: Date.parse("2026-04-13T16:00:00.000Z"),
      everyMs: 60_000,
      consecutiveErrors: 1,
      status: "error" as const,
      mockNextRun: true,
      expectedMsg: "cron: next run unresolved during transient error retry; clearing schedule",
    },
    {
      name: "error retry with non-finite everyMs",
      id: "cron-66019-every-error-invalid-interval",
      scheduledAt: Date.parse("2026-04-13T16:05:00.000Z"),
      invalidEveryMs: true,
      consecutiveErrors: 1,
      status: "error" as const,
      mockNextRun: false,
      expectedMsg: "cron: next run unresolved during transient error retry; clearing schedule",
    },
    {
      name: "successful completion with mocked unresolved next run",
      id: "cron-66019-every-unresolved",
      scheduledAt: Date.parse("2026-04-13T16:10:00.000Z"),
      everyMs: 60_000,
      status: "ok" as const,
      mockNextRun: true,
      expectedMsg: "cron: next run unresolved after successful completion; clearing schedule",
    },
    {
      name: "successful completion with non-finite everyMs",
      id: "cron-66019-every-success-invalid-interval",
      scheduledAt: Date.parse("2026-04-13T16:15:00.000Z"),
      invalidEveryMs: true,
      status: "ok" as const,
      mockNextRun: false,
      expectedMsg: "cron: next run unresolved after successful completion; clearing schedule",
    },
  ])(
    "warns and clears every unresolved next run: $name",
    async ({
      id,
      scheduledAt,
      everyMs,
      invalidEveryMs,
      consecutiveErrors,
      status,
      mockNextRun,
      expectedMsg,
    }) => {
      const everyJob = createEveryUnresolvedFixture({
        id,
        scheduledAt,
        everyMs,
        invalidEveryMs,
        consecutiveErrors,
      });
      const { state, warnLogs } = createWarnCapturingState(scheduledAt);
      state.store = { version: 1, jobs: [everyJob] };

      const scheduleSpy = mockNextRun
        ? vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined)
        : undefined;
      const jobSpy =
        status === "ok" && mockNextRun
          ? vi.spyOn(jobs, "computeJobNextRunAtMs").mockReturnValue(undefined)
          : undefined;
      try {
        applyJobResult(state, everyJob, {
          status,
          ...(status === "error" ? { error: "429 rate limit exceeded" } : {}),
          startedAt: scheduledAt,
          endedAt: scheduledAt + 1_000,
        });

        expect(everyJob.state.nextRunAtMs).toBeUndefined();
        expect(warnLogs).toContainEqual({
          obj: { jobId: id, jobName: id, scheduleKind: "every" },
          msg: expectedMsg,
        });
      } finally {
        scheduleSpy?.mockRestore();
        jobSpy?.mockRestore();
      }
    },
  );

  it("preserves the active error backoff floor when maintenance repair later finds a natural next run", async () => {
    const store = issue66019Fixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-04-13T15:50:00.000Z");
    let now = scheduledAt;

    const cronJob = createIssue66019Job({
      id: "cron-66019-error-backoff-floor",
      scheduledAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [cronJob] });

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "error",
      error: "synthetic failure",
    });
    const naturalNext = scheduledAt + 5_000;
    const backoffNext = scheduledAt + 30_000;
    const nextRunSpy = vi
      .spyOn(schedule, "computeNextRunAtMs")
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(naturalNext);
    const state = createIssue66019State({
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob,
    });

    try {
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(backoffNext);

      now = naturalNext + 1;
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      now = backoffNext + 1;
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    } finally {
      nextRunSpy.mockRestore();
      clearCronTimer(state);
    }
  });
});
