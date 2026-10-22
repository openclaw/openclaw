import { expect, it, vi } from "vitest";
import {
  createCronRegressionState as createCronServiceState,
  createDefaultIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as schedule from "../schedule.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import { needsCronTimerMaintenance } from "./jobs-scheduling.js";
import type { CronServiceDeps, DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import { applyJobResult } from "./timer-outcomes.js";
import { onTimer, runMissedJobs } from "./timer.test-support.js";

const timerRegressionFixtures = setupCronRegressionFixtures({ prefix: "cron-outcomes-" });
const startedAt = Date.parse("2026-10-05T00:00:00.000Z");

function outcomeFixture(
  runAt: number,
  overrides: Partial<CronJob> = {},
  deps: Partial<Parameters<typeof createCronServiceState>[0]> = {},
) {
  const job = {
    ...createIsolatedRegressionJob({
      id: "outcome",
      name: "outcome",
      scheduledAt: runAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: runAt },
      payload: { kind: "agentTurn", message: "report" },
    }),
    ...overrides,
  };
  const state = createCronServiceState({
    storePath: `/tmp/cron-${job.id}.json`,
    nowMs: () => runAt,
    runIsolatedAgentJob: createDefaultIsolatedRunner(),
    ...deps,
  });
  const deferredNotifications: DeferredCronNotifications = [];
  const apply = (
    result: Omit<Parameters<typeof applyJobResult>[2], "startedAt" | "endedAt"> &
      Partial<Pick<Parameters<typeof applyJobResult>[2], "startedAt" | "endedAt">>,
    options: Partial<Parameters<typeof applyJobResult>[3]> = {},
  ) =>
    applyJobResult(
      state,
      job,
      { startedAt: runAt, endedAt: runAt + 10, ...result },
      { deferredNotifications, ...options },
    );
  return { state, job, apply, deferredNotifications };
}

it.each([false, true])("never invents an event retry slot during outcome replay=%s", (replay) => {
  const { job, apply } = outcomeFixture(startedAt, {
    schedule: { kind: "event", source: "mcp-events", options: {} },
    state: { sourceIdentity: "source-generation" },
  });
  apply(
    { status: "error", error: "rate limit", endedAt: startedAt + 1 },
    replay ? { replay: true, replaySchedule: { nextRunAtMs: startedAt + 60_000 } } : {},
  );
  expect(job.enabled).toBe(true);
  expect(job.state.lastRunStatus).toBe("error");
  expect(job.state.consecutiveErrors).toBe(1);
  expect(job.state.nextRunAtMs).toBeUndefined();
  expect(job.state.sourceIdentity).toBe("source-generation");
});

it.each([0, 9, 10])("preserves %i failures after recurring-run cancellation", (priorErrors) => {
  const { job, apply, deferredNotifications } = outcomeFixture(startedAt, {
    state: { consecutiveErrors: priorErrors },
    failureAlert: { after: 1, cooldownMs: 0 },
  });
  apply({
    status: "error",
    error: "Gateway restarting.",
    errorClassification: { kind: "aborted" },
    endedAt: startedAt + 1,
  });

  expect(job).toMatchObject({
    enabled: true,
    state: {
      lastError: "Gateway restarting.",
      lastRunStatus: "error",
      consecutiveErrors: priorErrors,
    },
  });
  expect(job.state.autoDisabled).toBeUndefined();
  expect(job.state.failureAlertIncident).toBeUndefined();
  // Interrupted runs retain error scheduling, including its minimum backoff.
  const nextRunAtMs = startedAt + (priorErrors === 0 ? 60_000 : 3_600_001);
  expect(job.state.nextRunAtMs).toBe(nextRunAtMs);
  expect(needsCronTimerMaintenance(job, startedAt + 60_000)).toBe(false);
  expect(needsCronTimerMaintenance(job, nextRunAtMs)).toBe(false);
  expect(deferredNotifications).toEqual([]);
});

it("preserves every cadence after a transient recurring retry succeeds", () => {
  const scheduledAt = Date.parse("2026-05-29T02:28:00.000Z");
  const everyTwelveHoursMs = 12 * 60 * 60 * 1_000;
  const retryStartedAt = scheduledAt + 1_001;

  const { job, apply } = outcomeFixture(retryStartedAt, {
    schedule: { kind: "every", everyMs: everyTwelveHoursMs, anchorMs: scheduledAt },
    state: { nextRunAtMs: retryStartedAt, consecutiveErrors: 1 },
  });
  apply({ status: "ok", endedAt: retryStartedAt });
  expect(job.state.lastStatus).toBe("ok");
  expect(job.state.nextRunAtMs).toBe(scheduledAt + everyTwelveHoursMs);
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
    const enqueueSessionEvent = vi.fn(() => {
      const persisted = openOpenClawStateDatabase()
        .db.prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(cronStoreKey(store.storePath), malformed.id) as { enabled: number };
      expect(persisted.enabled).toBe(0);
      order.push("notify");
    });
    const state = createCronServiceState({
      storePath: store.storePath,
      nowMs: () => now,
      enqueueSessionEvent,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
    });
    if (path === "startup catch-up") {
      await runMissedJobs(state);
    } else {
      await onTimer(state);
    }

    expect(order).toEqual(["notify"]);
    expect(state.store?.jobs.find((job) => job.id === malformed.id)?.enabled).toBe(false);
    expect(
      (await loadCronStore(store.storePath)).jobs.find((job) => job.id === malformed.id),
    ).toMatchObject({ enabled: false });
  },
);

it("records failure diagnostics and auto-disables on the tenth consecutive failure", async () => {
  const enqueueSessionEvent = vi.fn();
  const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
    async () => undefined,
  );
  const log = { ...noopLogger, warn: vi.fn() };
  const diagnostics = {
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
  } satisfies NonNullable<Parameters<typeof applyJobResult>[2]["diagnostics"]>;
  const { state, job, apply, deferredNotifications } = outcomeFixture(
    startedAt,
    { state: { consecutiveErrors: 8 }, failureAlert: { after: 10, cooldownMs: 0 } },
    { enqueueSessionEvent, sendCronFailureAlert, log },
  );
  apply({ status: "error", error: "ninth failure", diagnostics: structuredClone(diagnostics) });
  expect(job.enabled).toBe(true);
  expect(job.state.consecutiveErrors).toBe(9);
  expect(job.state.autoDisabled).toBeUndefined();
  expect(deferredNotifications).toHaveLength(0);
  expect(job.state.lastDiagnostics).toEqual(diagnostics);
  expect(job.state.lastDiagnosticSummary).toBe("exec stderr tail");
  expect(log.warn).toHaveBeenCalledWith(
    {
      jobId: job.id,
      jobName: job.name,
      error: "ninth failure",
      diagnosticsSummary: "exec stderr tail",
    },
    "cron: job run returned error status",
  );

  apply({
    status: "error",
    error: "tenth failure",
    startedAt: startedAt + 60_000,
    endedAt: startedAt + 60_010,
  });
  expect(job.enabled).toBe(false);
  expect(job.state.nextRunAtMs).toBeUndefined();
  expect(job.state.autoDisabled).toEqual({
    reason: "consecutive-failures",
    atMs: startedAt + 60_010,
    consecutiveErrors: 10,
  });
  expect(deferredNotifications).toHaveLength(1);
  await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
  expect(sendCronFailureAlert).toHaveBeenCalledOnce();
  expect(sendCronFailureAlert.mock.calls[0]?.[0].payload.text).toContain(
    'Automation "outcome" was auto-disabled after 10 consecutive run failures.',
  );
  expect(enqueueSessionEvent).not.toHaveBeenCalled();
});

it.each([
  { name: "alerts disabled for the job", overrides: { failureAlert: false } },
  { name: "no failure route", overrides: { delivery: { mode: "none" } } },
] as const)("keeps the owning-agent notice with $name", async ({ overrides }) => {
  const enqueueSessionEvent = vi.fn();
  const sendCronFailureAlert = vi.fn(async () => undefined);
  const { state, job, apply, deferredNotifications } = outcomeFixture(
    startedAt,
    { ...overrides, state: { consecutiveErrors: 9 } } as Partial<CronJob>,
    { enqueueSessionEvent, sendCronFailureAlert, defaultAgentId: "main" },
  );

  apply({ status: "error", error: "tenth failure" });
  expect(job.state.autoDisabled?.reason).toBe("consecutive-failures");
  expect(deferredNotifications.map(({ kind }) => kind)).toEqual(["auto-disabled"]);
  await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
  expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("was auto-disabled after 10 consecutive run failures"),
    expect.objectContaining({ contextKey: `cron:${job.id}:auto-disabled` }),
  );
  expect(sendCronFailureAlert).not.toHaveBeenCalled();
});

it.each([
  {
    name: "webhook route, no earlier alert",
    failureAlert: { after: 20, mode: "webhook", to: "https://alerts.example.com/hook" },
    repairPending: false,
  },
  { name: "announce route, no earlier alert", failureAlert: { after: 20 }, repairPending: false },
  { name: "announce route, pending repair", failureAlert: { after: 2 }, repairPending: true },
] as const)(
  "sends an owned job's auto-disable notice through its route, not a repair turn ($name)",
  ({ failureAlert, repairPending }) => {
    const { job, apply, deferredNotifications } = outcomeFixture(startedAt, {
      owner: { agentId: "main", sessionKey: "agent:main:main" },
      failureAlert: { ...failureAlert },
      state: {
        consecutiveErrors: 9,
        failureAlertIncident: repairPending
          ? {
              scope: "run",
              repair: { atMs: startedAt - 60_000, deadlineAtMs: startedAt + 60_000 },
            }
          : undefined,
      },
    } as Partial<CronJob>);

    apply({ status: "error", error: "tenth failure" });

    expect(job.enabled).toBe(false);
    expect(deferredNotifications.map(({ kind }) => kind)).toEqual(["failure-alert"]);
    const [notification] = deferredNotifications;
    expect(notification?.kind === "failure-alert" && notification.payload.text).toContain(
      "was auto-disabled after 10 consecutive run failures",
    );
    if (repairPending) {
      expect(job.state.failureAlertIncident?.repair?.alerted).toBe(true);
    }
  },
);

it.each([
  { name: "stale", options: { scheduleOwnership: "stale" } },
  { name: "forced", options: { scheduleMode: "preserve" } },
] as const)("keeps a $name schedule enabled while alerting on its tenth failure", ({ options }) => {
  const { job, apply, deferredNotifications } = outcomeFixture(startedAt, {
    state: { consecutiveErrors: 9, nextRunAtMs: startedAt + 60_000 },
  });

  apply({ status: "error", error: "tenth failure" }, options);

  expect(job.enabled).toBe(true);
  expect(job.state.consecutiveErrors).toBe(10);
  expect(job.state.autoDisabled).toBeUndefined();
  expect(deferredNotifications).toHaveLength(1);
});

it.each([
  { status: "ok", throws: true, at: "2026-03-02T12:00:00.000Z", durationMs: 50 },
  { status: "error", throws: true, at: "2026-03-02T12:05:00.000Z", durationMs: 25 },
  { status: "ok", throws: false, at: "2026-04-13T15:40:00.000Z", durationMs: 50 },
  { status: "error", throws: false, at: "2026-04-13T15:45:00.000Z", durationMs: 25 },
] as const)(
  "retains $status without inventing a next slot (schedule throws: $throws; #30905, #66019)",
  ({ status, throws, at, durationMs }) => {
    const caseStartedAt = Date.parse(at);
    const endedAt = caseStartedAt + durationMs;
    const { job, apply } = outcomeFixture(
      caseStartedAt,
      {
        schedule: {
          kind: "cron",
          expr: "0 7 * * *",
          tz: throws ? "Invalid/Timezone" : "Asia/Shanghai",
        },
        state: { nextRunAtMs: caseStartedAt - 1_000, runningAtMs: caseStartedAt - 500 },
      },
      { nowMs: () => endedAt },
    );
    const nextRunSpy = throws
      ? undefined
      : vi.spyOn(schedule, "computeNextRunAtMs").mockReturnValue(undefined);
    try {
      const shouldDelete = apply({
        status,
        ...(status === "ok"
          ? { delivered: true }
          : { error: throws ? "synthetic failure" : "429 rate limit exceeded" }),
        endedAt,
      });
      expect(shouldDelete).toBe(false);
      expect(job.state.runningAtMs).toBeUndefined();
      expect(job.state.lastRunAtMs).toBe(caseStartedAt);
      expect(job.state.lastStatus).toBe(status);
      expect(job.state.consecutiveErrors).toBe(status === "error" ? 1 : 0);
      expect(job.state.nextRunAtMs).toBeUndefined();
      expect(job.enabled).toBe(true);
      if (throws) {
        expect(job.state.scheduleErrorCount).toBe(1);
        expect(job.state.lastError).toMatch(/^schedule error:/);
      }
    } finally {
      nextRunSpy?.mockRestore();
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
    provider: "anthropic",
    errorClassification: undefined,
    expectedReason: "timeout",
    expectedRetryMs: 30_000,
  },
] as const)(
  "applies bounded retry classification for $id",
  ({ payload, error, provider, errorClassification, expectedReason, expectedRetryMs }) => {
    const endedAt = startedAt + 500;
    const { job, apply } = outcomeFixture(
      startedAt,
      {
        schedule: { kind: "at", at: new Date(startedAt).toISOString() },
        payload,
        state: { runningAtMs: startedAt },
      },
      { nowMs: () => endedAt },
    );

    apply({
      status: "error",
      error,
      provider,
      ...(errorClassification ? { errorClassification } : {}),
      executionStarted: true,
      endedAt,
    });

    expect(job.state.lastErrorReason).toBe(expectedReason);
    expect(job.state.nextRunAtMs).toBe(
      expectedRetryMs === undefined ? undefined : endedAt + expectedRetryMs,
    );
    expect(job.enabled).toBe(expectedRetryMs !== undefined);
  },
);

it.each(["ok", "error"] as const)("force run preserves the every cadence after %s", (status) => {
  const nowMs = Date.now();
  const everyMs = 24 * 60 * 60 * 1_000;
  const lastScheduledRunMs = nowMs - 6 * 60 * 60 * 1_000;
  const expectedNextMs = lastScheduledRunMs + everyMs;

  const { job, apply } = outcomeFixture(nowMs, {
    schedule: { kind: "every", everyMs, anchorMs: lastScheduledRunMs - everyMs },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    delivery: undefined,
    payload: { kind: "systemEvent", text: "daily check-in" },
    state: { lastRunAtMs: lastScheduledRunMs, nextRunAtMs: expectedNextMs },
  });

  apply(
    {
      status,
      ...(status === "error" ? { error: "429 rate limit exceeded" } : {}),
      endedAt: nowMs + 2_000,
    },
    { scheduleMode: "preserve" },
  );

  expect(job.state.lastRunAtMs).toBe(nowMs);
  expect(job.state.lastStatus).toBe(status);
  expect(job.state.nextRunAtMs).toBe(expectedNextMs);
});
