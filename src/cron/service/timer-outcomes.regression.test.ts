import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState as createCronServiceState,
  createDefaultIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as schedule from "../schedule.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import type { DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import { runMissedJobs } from "./timer-catchup.js";
import { applyJobResult } from "./timer-outcomes.js";
import { onTimer } from "./timer.test-support.js";

const timerRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timer-outcomes-regressions-",
});

describe("cron timer outcome and failure policy regressions", () => {
  it("preserves every cadence after a transient recurring retry succeeds", () => {
    const scheduledAt = Date.parse("2026-05-29T02:28:00.000Z");
    const everyTwelveHoursMs = 12 * 60 * 60 * 1_000;
    const retryStartedAt = scheduledAt + 1_001;

    const cronJob = createIsolatedRegressionJob({
      id: "recurring-rate-limit-edited",
      name: "edited recurring report",
      scheduledAt: retryStartedAt,
      schedule: { kind: "every", everyMs: everyTwelveHoursMs, anchorMs: scheduledAt },
      payload: { kind: "agentTurn", message: "closure report" },
      state: {
        nextRunAtMs: retryStartedAt,
        consecutiveErrors: 1,
      },
    });
    const state = createRunningCronServiceState({
      storePath: "/tmp/cron-recurring-rate-limit-edited.json",
      log: noopLogger,
      nowMs: () => retryStartedAt,
      jobs: [cronJob],
    });

    applyJobResult(
      state,
      cronJob,
      {
        status: "ok",
        startedAt: retryStartedAt,
        endedAt: retryStartedAt,
      },
      { deferredNotifications: [] },
    );

    expect(cronJob.state.lastStatus).toBe("ok");
    expect(cronJob.state.nextRunAtMs).toBe(scheduledAt + everyTwelveHoursMs);
  });

  it.each(["timer maintenance", "startup catch-up"] as const)(
    "persists schedule auto-disable before notifying during %s",
    async (path) => {
      const store = timerRegressionFixtures.makeStorePath();
      const now = Date.parse("2026-08-01T11:00:00.000Z");
      const malformed = createIsolatedRegressionJob({
        id: `malformed-${path}`,
        name: `malformed ${path}`,
        scheduledAt: now,
        schedule: { kind: "cron", expr: "invalid" },
        payload: { kind: "agentTurn", message: "malformed" },
        state: { scheduleErrorCount: 2 },
      });
      const jobs =
        path === "startup catch-up"
          ? [
              createDueIsolatedJob({ id: "due-startup-catch-up", nowMs: now, nextRunAtMs: now }),
              malformed,
            ]
          : [malformed];
      await saveCronStore(store.storePath, { version: 1, jobs });

      const order: string[] = [];
      const enqueueSystemEvent = vi.fn(() => {
        const persisted = openOpenClawStateDatabase()
          .db.prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(cronStoreKey(store.storePath), malformed.id) as { enabled: number };
        expect(persisted.enabled).toBe(0);
        order.push("notify");
      });
      const requestHeartbeat = vi.fn(() => {
        expect(order.at(-1)).toBe("notify");
        order.push("heartbeat");
      });
      const state = createCronServiceState({
        storePath: store.storePath,
        nowMs: () => now,
        enqueueSystemEvent,
        requestHeartbeat,
        runIsolatedAgentJob: createDefaultIsolatedRunner(),
      });
      if (path === "startup catch-up") {
        await runMissedJobs(state);
      } else {
        await onTimer(state);
      }

      expect(order).toEqual(["notify", "heartbeat"]);
      expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(false);
      expect(
        (await loadCronStore(store.storePath)).jobs.find((job) => job.id === malformed.id),
      ).toMatchObject({ enabled: false });
    },
  );

  it("auto-disables a recurring job on its tenth consecutive run failure", () => {
    const startedAt = Date.parse("2026-08-01T12:00:00.000Z");
    const deferredNotifications: DeferredCronNotifications = [];
    const enqueueSystemEvent = vi.fn();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      storePath: "/tmp/cron-consecutive-failure-threshold.json",
      nowMs: () => startedAt,
      enqueueSystemEvent,
      sendCronFailureAlert,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "recurring-failure-threshold",
      name: "recurring failure threshold",
      scheduledAt: startedAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt },
      payload: { kind: "agentTurn", message: "fail" },
      state: { consecutiveErrors: 8 },
    });
    job.failureAlert = { after: 10, cooldownMs: 0 };

    applyJobResult(
      state,
      job,
      { status: "error", error: "ninth failure", startedAt, endedAt: startedAt + 10 },
      { deferredNotifications },
    );
    expect(job.enabled).toBe(true);
    expect(job.state.consecutiveErrors).toBe(9);
    expect(job.state.autoDisabled).toBeUndefined();
    expect(deferredNotifications).toHaveLength(0);

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "tenth failure",
        startedAt: startedAt + 60_000,
        endedAt: startedAt + 60_010,
      },
      { deferredNotifications },
    );
    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.autoDisabled).toEqual({
      reason: "consecutive-failures",
      atMs: startedAt + 60_010,
      consecutiveErrors: 10,
    });
    expect(deferredNotifications).toHaveLength(1);
    runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
  });

  it("resets the auto-disable streak after a successful recurring run", () => {
    const startedAt = Date.parse("2026-08-01T13:00:00.000Z");
    const state = createCronServiceState({
      storePath: "/tmp/cron-consecutive-failure-reset.json",
      nowMs: () => startedAt,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "recurring-failure-reset",
      name: "recurring failure reset",
      scheduledAt: startedAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt },
      payload: { kind: "agentTurn", message: "recover" },
      state: {},
    });
    const apply = (status: "ok" | "error", run: number) =>
      applyJobResult(
        state,
        job,
        {
          status,
          ...(status === "error" ? { error: `failure ${run}` } : {}),
          startedAt: startedAt + run * 60_000,
          endedAt: startedAt + run * 60_000 + 10,
        },
        { deferredNotifications: [] },
      );

    for (let run = 0; run < 9; run += 1) {
      apply("error", run);
    }
    apply("ok", 9);
    for (let run = 10; run < 19; run += 1) {
      apply("error", run);
    }

    expect(job.enabled).toBe(true);
    expect(job.state.consecutiveErrors).toBe(9);
    expect(job.state.autoDisabled).toBeUndefined();
  });

  it.each([
    { name: "stale schedule", opts: { scheduleOwnership: "stale" as const } },
    { name: "forced run", opts: { scheduleMode: "preserve" as const } },
  ])("does not auto-disable but still alerts after a $name failure", ({ opts }) => {
    const startedAt = Date.parse("2026-08-01T14:00:00.000Z");
    const deferredNotifications: DeferredCronNotifications = [];
    const state = createCronServiceState({
      storePath: "/tmp/cron-non-owning-failure.json",
      nowMs: () => startedAt,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    const job = createIsolatedRegressionJob({
      id: "non-owning-recurring-failure",
      name: "non-owning recurring failure",
      scheduledAt: startedAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt },
      payload: { kind: "agentTurn", message: "fail" },
      state: { consecutiveErrors: 9, nextRunAtMs: startedAt + 60_000 },
    });

    applyJobResult(
      state,
      job,
      { status: "error", error: "tenth failure", startedAt, endedAt: startedAt + 10 },
      { ...opts, deferredNotifications },
    );

    expect(job.enabled).toBe(true);
    expect(job.state.consecutiveErrors).toBe(10);
    expect(job.state.autoDisabled).toBeUndefined();
    expect(deferredNotifications).toHaveLength(1);
  });

  it.each([
    { status: "ok", label: "success", at: "2026-03-02T12:00:00.000Z", durationMs: 50 },
    { status: "error", label: "error", at: "2026-03-02T12:05:00.000Z", durationMs: 25 },
  ] as const)(
    "keeps $status state when cron next-run computation throws (#30905)",
    ({ status, label, at, durationMs }) => {
      const startedAt = Date.parse(at);
      const endedAt = startedAt + durationMs;
      const state = createCronServiceState({
        storePath: `/tmp/cron-30905-${label}.json`,
        nowMs: () => endedAt,
        runIsolatedAgentJob: createDefaultIsolatedRunner(),
      });
      const job = createIsolatedRegressionJob({
        id: `apply-result-${label}-30905`,
        name: `apply-result-${label}-30905`,
        scheduledAt: startedAt,
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "Invalid/Timezone" },
        payload: { kind: "agentTurn", message: "ping" },
        state: { nextRunAtMs: startedAt - 1_000, runningAtMs: startedAt - 500 },
      });

      const shouldDelete = applyJobResult(
        state,
        job,
        {
          status,
          ...(status === "ok" ? { delivered: true } : { error: "synthetic failure" }),
          startedAt,
          endedAt,
        },
        { deferredNotifications: [] },
      );

      expect(shouldDelete).toBe(false);
      expect(job.state.runningAtMs).toBeUndefined();
      expect(job.state.lastRunAtMs).toBe(startedAt);
      expect(job.state.lastStatus).toBe(status);
      expect(job.state.consecutiveErrors).toBe(status === "error" ? 1 : 0);
      expect(job.state.scheduleErrorCount).toBe(1);
      expect(job.state.lastError).toMatch(/^schedule error:/);
      expect(job.state.nextRunAtMs).toBeUndefined();
      expect(job.enabled).toBe(true);
    },
  );

  it.each([
    { status: "ok", label: "success", at: "2026-04-13T15:40:00.000Z", durationMs: 50 },
    { status: "error", label: "error", at: "2026-04-13T15:45:00.000Z", durationMs: 25 },
  ] as const)(
    "does not synthesize retries after $status when no cron slot exists (#66019)",
    ({ status, label, at, durationMs }) => {
      const startedAt = Date.parse(at);
      const endedAt = startedAt + durationMs;
      const state = createCronServiceState({
        storePath: `/tmp/cron-66019-${label}.json`,
        nowMs: () => endedAt,
        runIsolatedAgentJob: createDefaultIsolatedRunner(),
      });
      const job = createIsolatedRegressionJob({
        id: `cron-66019-${label}`,
        name: `cron-66019-${label}`,
        scheduledAt: startedAt,
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
        payload: { kind: "agentTurn", message: "ping" },
        state: { nextRunAtMs: startedAt - 1_000, runningAtMs: startedAt - 500 },
      });
      const nextRunSpy = vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);

      try {
        const shouldDelete = applyJobResult(
          state,
          job,
          {
            status,
            ...(status === "ok" ? { delivered: true } : { error: "429 rate limit exceeded" }),
            startedAt,
            endedAt,
          },
          { deferredNotifications: [] },
        );

        expect(shouldDelete).toBe(false);
        expect(job.state.runningAtMs).toBeUndefined();
        expect(job.state.lastRunAtMs).toBe(startedAt);
        expect(job.state.lastStatus).toBe(status);
        expect(job.state.consecutiveErrors).toBe(status === "error" ? 1 : 0);
        expect(job.state.nextRunAtMs).toBeUndefined();
        expect(job.enabled).toBe(true);
      } finally {
        nextRunSpy.mockRestore();
      }
    },
  );

  it.each([
    {
      id: "permanent-script-failure",
      payload: { kind: "script", script: "throw new Error('request timed out')" },
      error: "cron script failed after a tool side effect: request timed out",
      errorClassification: { kind: "permanent" },
      expectedReason: undefined,
      expectedRetryMs: undefined,
    },
    {
      id: "transient-script-timeout",
      payload: { kind: "script", script: "while (true) {}" },
      error: "cron script payload failed (timeout): wall-clock timeout exceeded",
      errorClassification: { kind: "reason", reason: "timeout" },
      expectedReason: "timeout",
      expectedRetryMs: 30_000,
    },
    {
      id: "transient-agent-transport",
      payload: { kind: "agentTurn", message: "ping" },
      error: "stream disconnected before completion: upstream reset",
      errorClassification: undefined,
      expectedReason: "timeout",
      expectedRetryMs: 30_000,
    },
  ] as const)(
    "applies bounded retry classification for $id",
    ({ id, payload, error, errorClassification, expectedReason, expectedRetryMs }) => {
      const startedAt = Date.parse("2026-07-21T12:00:00.000Z");
      const endedAt = startedAt + 500;
      const job = createIsolatedRegressionJob({
        id,
        name: id,
        scheduledAt: startedAt,
        schedule: { kind: "at", at: new Date(startedAt).toISOString() },
        payload,
        state: { runningAtMs: startedAt },
      });
      const state = createRunningCronServiceState({
        storePath: `/tmp/cron-${id}.json`,
        log: noopLogger,
        nowMs: () => endedAt,
        jobs: [job],
      });

      applyJobResult(
        state,
        job,
        {
          status: "error",
          error,
          ...(errorClassification ? { errorClassification } : {}),
          executionStarted: true,
          startedAt,
          endedAt,
        },
        { deferredNotifications: [] },
      );

      expect(job.state.lastErrorReason).toBe(expectedReason);
      expect(job.state.nextRunAtMs).toBe(
        expectedRetryMs === undefined ? undefined : endedAt + expectedRetryMs,
      );
      expect(job.enabled).toBe(expectedRetryMs !== undefined);
    },
  );

  it.each([
    { status: "ok", id: "daily-job", name: "Daily job", path: "anchor-test" },
    {
      status: "error",
      id: "daily-job-transient-force",
      name: "Daily job transient force",
      path: "transient-anchor-test",
    },
  ] as const)(
    "force run preserves the every cadence after $status",
    ({ status, id, name, path }) => {
      const nowMs = Date.now();
      const everyMs = 24 * 60 * 60 * 1_000;
      const lastScheduledRunMs = nowMs - 6 * 60 * 60 * 1_000;
      const expectedNextMs = lastScheduledRunMs + everyMs;

      const job: CronJob = {
        id,
        name,
        enabled: true,
        createdAtMs: lastScheduledRunMs - everyMs,
        updatedAtMs: lastScheduledRunMs,
        schedule: { kind: "every", everyMs, anchorMs: lastScheduledRunMs - everyMs },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "daily check-in" },
        state: {
          lastRunAtMs: lastScheduledRunMs,
          nextRunAtMs: expectedNextMs,
        },
      };
      const state = createRunningCronServiceState({
        storePath: `/tmp/cron-force-run-${path}.json`,
        log: noopLogger,
        nowMs: () => nowMs,
        jobs: [job],
      });

      const startedAt = nowMs;
      const endedAt = nowMs + 2_000;

      applyJobResult(
        state,
        job,
        {
          status,
          ...(status === "error" ? { error: "429 rate limit exceeded" } : {}),
          startedAt,
          endedAt,
        },
        { deferredNotifications: [], scheduleMode: "preserve" },
      );

      expect(job.state.lastRunAtMs).toBe(startedAt);
      expect(job.state.lastStatus).toBe(status);
      expect(job.state.nextRunAtMs).toBe(expectedNextMs);
    },
  );

  it("persists and warns with last cron run diagnostics", () => {
    const startedAt = Date.parse("2026-04-14T12:00:00.000Z");
    const endedAt = startedAt + 500;
    const job = createIsolatedRegressionJob({
      id: "diagnostics-job",
      name: "diagnostics-job",
      scheduledAt: startedAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt },
      payload: { kind: "agentTurn", message: "diagnose" },
      state: { runningAtMs: startedAt },
    });
    const log = { ...noopLogger, warn: vi.fn() };
    const state = createCronServiceState({
      storePath: "/tmp/cron-diagnostics-job.json",
      log,
      nowMs: () => endedAt,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "failed",
        diagnostics: {
          summary: "exec stderr tail",
          entries: [
            {
              ts: startedAt,
              source: "exec",
              severity: "error",
              message: "exec stderr tail",
              exitCode: 1,
            },
          ],
        },
        startedAt,
        endedAt,
      },
      { deferredNotifications: [] },
    );

    expect(job.state.lastDiagnostics?.summary).toBe("exec stderr tail");
    expect(job.state.lastDiagnostics?.entries).toEqual([
      {
        ts: startedAt,
        source: "exec",
        severity: "error",
        message: "exec stderr tail",
        exitCode: 1,
      },
    ]);
    expect(job.state.lastDiagnosticSummary).toBe("exec stderr tail");
    expect(log.warn).toHaveBeenCalledWith(
      {
        jobId: "diagnostics-job",
        jobName: "diagnostics-job",
        error: "failed",
        diagnosticsSummary: "exec stderr tail",
      },
      "cron: job run returned error status",
    );
  });
});
