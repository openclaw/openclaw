import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import type { CronService } from "./service.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import type { CronEvent, CronServiceDeps } from "./service/state.js";
import {
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  MIN_REFIRE_GAP_MS,
} from "./service/timer-execution-timeout.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import { parseCronScheduledRunId } from "./store/run-request-id.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-one-shot-schedule-ownership-",
  fakeTimers: false,
});
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let storePath: string;
beforeEach(async () => {
  ({ storePath } = await makeStorePath());
  clock = createGatewaySchedulerClock(Date.parse("2026-07-27T12:00:00.000Z"));
});

function createCron(
  params: Pick<CronServiceDeps, "runIsolatedAgentJob"> &
    Partial<
      Pick<
        CronServiceDeps,
        "runSessionEvent" | "runCommandJob" | "onEvent" | "enqueueSystemEvent" | "requestHeartbeat"
      >
    >,
) {
  return createCronServiceWithStateForTest({
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    ...params,
  });
}

function createQueueBlocker() {
  const started = createDeferred();
  const release = createDeferred();
  let active = 0;
  const runCommandJob: NonNullable<CronServiceDeps["runCommandJob"]> = async () => {
    if (++active === DEFAULT_CRON_MAX_CONCURRENT_RUNS) {
      started.resolve();
    }
    await release.promise;
    return { status: "ok" };
  };
  return {
    runCommandJob,
    async occupy(cron: CronService, signal: AbortSignal) {
      const jobs = await Promise.all(
        Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, (_, index) =>
          cron.add({
            name: `capacity blocker ${index}`,
            enabled: false,
            schedule: { kind: "at", at: new Date(clock.clock.now() + 86_400_000).toISOString() },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "command", argv: ["synthetic-capacity-blocker"] },
            delivery: { mode: "none" },
          }),
        ),
      );
      const runs = jobs.map((job) => cron.run(job.id, "force"));
      let released = false;
      const finish = async () => {
        release.resolve();
        await Promise.all(runs);
        if (!released) {
          released = true;
          await Promise.all(jobs.map((job) => cron.remove(job.id)));
        }
      };
      try {
        await withinTest(started.promise, signal);
      } catch (error) {
        await finish();
        throw error;
      }
      return finish;
    },
  };
}

async function addOneShot(
  cron: CronService,
  name: string,
  atMs: number,
  overrides: Partial<Pick<CronJob, "id" | "deleteAfterRun" | "enabled">> = {},
) {
  return await cron.add({
    name,
    enabled: true,
    schedule: { kind: "at", at: new Date(atMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "verify one-shot schedule ownership" },
    delivery: { mode: "none" },
    ...overrides,
  });
}

async function jobViews(cron: CronService) {
  return [await cron.list({ includeDisabled: true }), (await loadCronStore(storePath)).jobs];
}

function historyFor(jobId: string) {
  return readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId }).entries;
}

function createAgentGate(matches: (event: CronEvent) => boolean = () => true) {
  const started = createDeferred();
  const release = createDeferred();
  const events: CronEvent[] = [];
  const completion = { finished: createDeferred(), removed: createDeferred() };
  return {
    started,
    release,
    events,
    ...completion,
    onEvent(event: CronEvent) {
      events.push(event);
      if (matches(event) && (event.action === "finished" || event.action === "removed")) {
        completion[event.action].resolve();
      }
    },
    run: async () => {
      started.resolve();
      await release.promise;
      return { status: "ok" as const, summary: "done" };
    },
  };
}

async function expectOneShotState(
  cron: CronService,
  jobId: string,
  atMs: number,
  nextRunAtMs: number | undefined,
  enabled = true,
) {
  const expected = {
    id: jobId,
    enabled,
    schedule: { kind: "at", at: new Date(atMs).toISOString() },
    state: { lastRunStatus: "ok", lastStatus: "ok" },
  };
  for (const jobs of await jobViews(cron)) {
    const stored = jobs.find((entry) => entry.id === jobId);
    expect(stored).toMatchObject(expected);
    expect(stored?.state.nextRunAtMs).toBe(nextRunAtMs);
    expect(stored?.state.runningAtMs).toBeUndefined();
  }
  expect(historyFor(jobId)).toEqual([
    expect.objectContaining({ status: "ok", completionStatus: "succeeded" }),
  ]);
}

it.for([
  { edit: "none", deleteAfterRun: true, overdueRestart: false },
  { edit: "none", deleteAfterRun: false, overdueRestart: true },
  { edit: "disable", deleteAfterRun: true, overdueRestart: false },
  { edit: "reschedule", deleteAfterRun: true, overdueRestart: false },
  { edit: "schedule round trip", deleteAfterRun: true, overdueRestart: false },
  { edit: "remove", deleteAfterRun: true, overdueRestart: false },
] as const)(
  "rearms only the current explicit continuation and retains its definition ($edit, deleteAfterRun=$deleteAfterRun)",
  async ({ edit, deleteAfterRun, overdueRestart }, { signal }) => {
    const delayMs = 60_000;
    const payload = createAgentGate();
    const runSessionEvent = vi
      .fn<NonNullable<CronServiceDeps["runSessionEvent"]>>()
      .mockImplementationOnce(async () => {
        await payload.run();
        return { status: "ok", summary: "CI is pending", nextCheck: { delayMs } };
      })
      .mockResolvedValue({ status: "ok", summary: "CI passed" });
    const options = {
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runSessionEvent,
    };
    let { cron } = createCron(options);
    try {
      await cron.start();
      cron.pauseScheduling();
      const atMs = clock.clock.now() + 1_000;
      const job = await cron.add({
        name: "CI continuation",
        enabled: true,
        deleteAfterRun,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "session:agent:main:dashboard:synthetic-ci",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "Check CI and finish the authorized work.",
          toolsAllow: ["automations"],
        },
        delivery: { mode: "none" },
      });
      clock.setTime(atMs);
      const pendingRun = cron.run(job.id, "due");
      await withinTest(payload.started.promise, signal);
      const editedAtMs = atMs + 600_000;
      if (edit === "disable") {
        await cron.update(job.id, { enabled: false });
      } else if (edit === "reschedule" || edit === "schedule round trip") {
        await cron.update(job.id, {
          schedule: { kind: "at", at: new Date(editedAtMs).toISOString() },
        });
        if (edit === "schedule round trip") {
          await cron.update(job.id, { schedule: job.schedule });
        }
      } else if (edit === "remove") {
        await cron.remove(job.id);
      }
      clock.setTime(atMs + 1_000);
      payload.release.resolve();
      await pendingRun;
      const continuationAtMs = atMs + 1_000 + delayMs;
      for (const jobs of await jobViews(cron)) {
        if (edit === "remove") {
          expect(jobs).toEqual([]);
          continue;
        }
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          id: job.id,
          enabled: edit !== "disable",
          schedule:
            edit === "reschedule"
              ? { kind: "at", at: new Date(editedAtMs).toISOString() }
              : { kind: "at", at: new Date(atMs).toISOString() },
          sessionTarget: "session:agent:main:dashboard:synthetic-ci",
          payload: {
            kind: "agentTurn",
            message: "Check CI and finish the authorized work.",
            toolsAllow: ["automations"],
          },
          deleteAfterRun,
        });
        expect(jobs[0]?.state.nextRunAtMs).toBe(
          edit === "none" ? continuationAtMs : edit === "reschedule" ? editedAtMs : undefined,
        );
      }
      if (edit !== "none") {
        return;
      }
      cron.stop();
      clock.setTime(continuationAtMs + (overdueRestart ? 1_000 : -1_000));
      ({ cron } = createCron(options));
      cron.pauseScheduling();
      await cron.start();
      expect(runSessionEvent).toHaveBeenCalledTimes(1);
      expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(continuationAtMs);
      clock.setTime(continuationAtMs + 2_000);
      await expect(cron.run(job.id, "due")).resolves.toMatchObject({ ok: true, ran: true });
      expect(runSessionEvent).toHaveBeenCalledTimes(2);
      for (const jobs of await jobViews(cron)) {
        if (deleteAfterRun) {
          expect(jobs).toEqual([]);
        } else {
          expect(jobs).toHaveLength(1);
          expect(jobs[0]?.enabled).toBe(false);
          expect(jobs[0]?.state.nextRunAtMs).toBeUndefined();
        }
      }
    } finally {
      payload.release.resolve();
      cron.stop();
    }
  },
);

it.for(["queued force", "scheduled", "due", "late force"] as const)(
  "recovers only scheduled work or its preserved occurrence after a %s run",
  async (mode, { signal }) => {
    const payload = createAgentGate();
    const capacity = createQueueBlocker();
    let interruptPayload = mode === "queued force";
    const runIsolatedAgentJob = vi.fn(async () =>
      interruptPayload ? await payload.run() : { status: "ok" as const, summary: "done" },
    );
    const options = { runIsolatedAgentJob, runCommandJob: capacity.runCommandJob };
    let { cron, state } = createCron(options);
    let releaseBlockers: (() => Promise<void>) | undefined;
    let interruptedRun: Promise<unknown> | undefined;
    let removeFailure: (() => void) | undefined;
    let requestedRunId: string | undefined;
    try {
      await cron.start();
      cron.pauseScheduling();
      if (mode === "queued force") {
        releaseBlockers = await capacity.occupy(cron, signal);
      }
      const atMs = clock.clock.now() + 1_000;
      const job = await addOneShot(cron, "borrowed occurrence crash state", atMs, {
        deleteAfterRun: false,
      });
      if (mode === "queued force") {
        const ack = await cron.enqueueRun(job.id, "force");
        expect(ack).toMatchObject({ ok: true, enqueued: true });
        if (!(ack.ok && "runId" in ack)) {
          throw new Error("Expected an acknowledged manual request");
        }
        requestedRunId = ack.runId;
        expect((await cron.readJob(job.id))?.state.queuedAtMs).toBe(clock.clock.now());
        clock.setTime(atMs + 1);
        await expectDefined(releaseBlockers, "queued capacity release")();
      } else {
        // A completed manual run leaves preservation provenance behind. An actual
        // scheduled receipt must still be retired after uncertain execution.
        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
        expect((await cron.readJob(job.id))?.state.forcePreservedNextRunAtMs).toBe(atMs);
        interruptPayload = true;
        clock.setTime(atMs + 1);
        if (mode === "scheduled") {
          cron.resumeScheduling();
          interruptedRun = onTimer(state);
        } else {
          interruptedRun = cron.run(job.id, mode === "due" ? "due" : "force");
        }
        void interruptedRun.catch(() => {});
      }
      await withinTest(payload.started.promise, signal);
      const active = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
      expect(active?.state).toMatchObject({ runningAtMs: atMs + 1, nextRunAtMs: atMs });
      expect(active?.state.forcePreservedNextRunAtMs).toBe(
        mode === "queued force" ? atMs : undefined,
      );
      const receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      expect(receipt?.receiptId).toBe(active?.state.runningReceiptId);
      expect(receipt?.startedAtMs).toBe(atMs + 1);
      expect(receipt && parseCronScheduledRunId(receipt.receiptId)).toEqual(
        mode === "scheduled"
          ? { storeKey: cronStoreKey(storePath), jobId: job.id, scheduledSlotMs: atMs }
          : undefined,
      );

      // Reject the real terminal transaction, leaving the admitted receipt and
      // running marker exactly as a crash before terminal persistence would.
      const database = openOpenClawStateDatabase().db;
      database.exec(`
          CREATE TRIGGER reject_borrowed_occurrence_terminal
          BEFORE UPDATE OF state_json ON cron_jobs
          WHEN NEW.job_id = '${job.id.replaceAll("'", "''")}'
            AND json_extract(OLD.state_json, '$.runningAtMs') IS NOT NULL
            AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL
          BEGIN SELECT RAISE(ABORT, 'terminal occurrence write unavailable'); END;
        `);
      removeFailure = () => database.exec("DROP TRIGGER reject_borrowed_occurrence_terminal");
      cron.stop();
      payload.release.resolve();
      if (interruptedRun) {
        await expect(interruptedRun).rejects.toThrow("terminal occurrence write unavailable");
      }
      await cron.waitForIdle();
      const persisted = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
      expect(persisted?.state.runningAtMs).toBe(atMs + 1);
      expect(historyFor(job.id)).toHaveLength(mode === "queued force" ? 0 : 1);
      removeFailure();
      removeFailure = undefined;

      interruptPayload = false;
      ({ cron, state } = createCron(options));
      cron.pauseScheduling();
      await cron.start();
      const recovered = expectDefined(await cron.readJob(job.id), "recovered one-shot");
      expect(recovered?.state.runningAtMs).toBeUndefined();
      expect(recovered?.state.lastError).toBe("cron: job interrupted by gateway restart");
      const resumesScheduledWork = mode === "queued force" || mode === "scheduled";
      expect(recovered.enabled).toBe(resumesScheduledWork);
      expect(historyFor(job.id).filter((entry) => entry.status === "error")).toEqual([
        expect.objectContaining({
          error: "cron: job interrupted by gateway restart",
          ...(requestedRunId ? { runId: requestedRunId } : {}),
        }),
      ]);
      if (resumesScheduledWork) {
        expect(recovered?.state.nextRunAtMs).toEqual(expect.any(Number));
        clock.setTime(expectDefined(recovered.state.nextRunAtMs, "scheduled continuation"));
      } else {
        expect(recovered?.state.nextRunAtMs).toBeUndefined();
      }
      cron.resumeScheduling();
      await onTimer(state);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(mode === "scheduled" ? 3 : 2);
      if (resumesScheduledWork) {
        expect((await cron.readJob(job.id))?.enabled).toBe(false);
      }
    } finally {
      payload.release.resolve();
      await releaseBlockers?.();
      cron.stop();
      await cron.waitForIdle();
      await Promise.allSettled(interruptedRun ? [interruptedRun] : []);
      removeFailure?.();
    }
  },
);

it.each([
  { mode: "direct", deleteAfterRun: false },
  { mode: "queued", deleteAfterRun: true },
] as const)(
  "does not finalize an active $mode run into a removed and recreated one-shot (deleteAfterRun=$deleteAfterRun)",
  async ({ mode, deleteAfterRun }) => {
    const payload = createAgentGate();
    const { cron } = createCron({
      runIsolatedAgentJob: vi.fn(payload.run),
      onEvent: (event: CronEvent) => payload.onEvent(event),
    });

    try {
      await cron.start();
      const atMs = clock.clock.now() + 60 * 60_000;
      const original = await addOneShot(cron, "removed original one-shot", atMs, {
        id: `removed-active-${mode}-${deleteAfterRun}`,
        deleteAfterRun,
      });
      const directRun = mode === "direct" ? cron.run(original.id, "force") : undefined;
      if (mode === "queued") {
        const ack = await cron.enqueueRun(original.id, "force");
        expect(ack).toMatchObject({ ok: true, enqueued: true });
      }
      await payload.started.promise;

      await expect(cron.remove(original.id)).resolves.toEqual({
        ok: true,
        removed: true,
        activeRunCancellationRequested: true,
      });
      await addOneShot(cron, "independent replacement one-shot", atMs, {
        id: original.id,
        deleteAfterRun,
      });

      payload.release.resolve();
      if (directRun) {
        await expect(directRun).resolves.toEqual({ ok: true, ran: true });
      } else {
        await payload.finished.promise;
      }
      await cron.status();

      for (const jobs of await jobViews(cron)) {
        const replacement = jobs.find((job) => job.id === original.id);
        expect(replacement).toMatchObject({
          id: original.id,
          name: "independent replacement one-shot",
          enabled: true,
          deleteAfterRun,
          state: { nextRunAtMs: atMs },
        });
        for (const key of ["lastRunAtMs", "lastRunStatus", "lastStatus", "runningAtMs"] as const) {
          expect(replacement?.state[key]).toBeUndefined();
        }
      }

      const failure = { status: "error", error: "Cron job removed by operator." };
      const removed = { ...failure, deliveryStatus: "not-requested" };
      const finishedEvents = payload.events.filter(
        (event) => event.action === "finished" && event.jobId === original.id,
      );
      expect(finishedEvents).toMatchObject([
        { ...removed, job: { name: "removed original one-shot" } },
      ]);
      expect(historyFor(original.id)).toMatchObject([
        { ...removed, runId: finishedEvents[0]?.runId },
      ]);
      const receipts = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status, error_text AS error FROM cron_run_receipts WHERE store_key = ? AND job_id = ?",
        )
        .all(cronStoreKey(storePath), original.id);
      expect(receipts).toMatchObject([failure]);
    } finally {
      payload.release.resolve();
      cron.stop();
    }
  },
);

it.for([
  { enableDuringRun: false, editSchedule: false },
  { enableDuringRun: false, editSchedule: true },
  { enableDuringRun: true, editSchedule: false },
  { enableDuringRun: true, editSchedule: true },
])(
  "preserves only an unchanged queued occurrence (enableDuringRun=$enableDuringRun, editSchedule=$editSchedule)",
  async ({ enableDuringRun, editSchedule }, { signal }) => {
    let targetId: string | undefined;
    const payload = createAgentGate((event) => event.jobId === targetId);
    const capacity = createQueueBlocker();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    if (enableDuringRun) {
      runIsolatedAgentJob.mockImplementationOnce(payload.run);
    }
    const options = {
      runIsolatedAgentJob,
      runCommandJob: capacity.runCommandJob,
      onEvent: (event: CronEvent) => payload.onEvent(event),
    };
    let { cron } = createCron(options);
    let releaseBlockers: (() => Promise<void>) | undefined;
    try {
      await cron.start();
      cron.pauseScheduling();
      releaseBlockers = await capacity.occupy(cron, signal);
      const atMs = clock.clock.now() + 1_000;
      const job = await addOneShot(cron, "queued across deadline", atMs, { enabled: false });
      targetId = job.id;
      const ack = await cron.enqueueRun(job.id, "force");
      expect(ack).toMatchObject({ ok: true, enqueued: true });
      expect((await cron.readJob(job.id))?.state.queuedAtMs).toEqual(expect.any(Number));
      clock.setTime(atMs + 1);
      await releaseBlockers();
      if (enableDuringRun) {
        await withinTest(payload.started.promise, signal);
        clock.setTime(atMs + 10);
        if (editSchedule) {
          await cron.update(job.id, { schedule: { kind: "every", everyMs: 60_000 } });
          await cron.update(job.id, { schedule: { kind: "at", at: new Date(atMs).toISOString() } });
        }
        await cron.update(job.id, { enabled: true });
        payload.release.resolve();
      }
      await withinTest(payload.finished.promise, signal);
      if (!enableDuringRun) {
        await cron.status();
      }
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      await expectOneShotState(
        cron,
        job.id,
        atMs,
        enableDuringRun && !editSchedule ? atMs : undefined,
        enableDuringRun,
      );

      cron.stop();
      const restarted = createCron(options);
      cron = restarted.cron;
      if (!enableDuringRun) {
        cron.pauseScheduling();
      }
      await cron.start();
      if (enableDuringRun) {
        expect(cron.getJob(job.id)?.state.nextRunAtMs).toEqual(
          editSchedule ? undefined : expect.any(Number),
        );
      } else {
        await expectOneShotState(cron, job.id, atMs, undefined, false);
        if (editSchedule) {
          await cron.update(job.id, { schedule: { kind: "every", everyMs: 60_000 } });
        }
        const resumed = await cron.update(job.id, {
          enabled: true,
          ...(editSchedule
            ? { schedule: { kind: "at" as const, at: new Date(atMs).toISOString() } }
            : {}),
        });
        expect(resumed.state.nextRunAtMs).toBe(editSchedule ? undefined : atMs);
        cron.resumeScheduling();
      }
      await clock.advanceBy(
        MIN_REFIRE_GAP_MS +
          (enableDuringRun ? DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS : 0),
      );
      await onTimer(restarted.state);
      if (!editSchedule) {
        await withinTest(payload.removed.promise, signal);
      }
      await cron.status();
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(editSchedule ? 1 : 2);
      expect((await loadCronStore(storePath)).jobs).toHaveLength(editSchedule ? 1 : 0);
    } finally {
      payload.release.resolve();
      await releaseBlockers?.();
      cron.stop();
    }
  },
);

it("recovers an overdue interrupted replacement without deleting it", async () => {
  const now = clock.clock.now();
  const interruptedAt = now - 30_000;
  const replacementAt = now - 5_000;
  const job: CronJob = {
    id: "restart-replacement",
    name: "restart replacement",
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 10_000,
    schedule: { kind: "at", at: new Date(replacementAt).toISOString() },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "run the replacement once" },
    state: { nextRunAtMs: replacementAt, runningAtMs: interruptedAt },
  };
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const onEvent = vi.fn((event: CronEvent) => event);
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const { cron } = createCron({
    enqueueSystemEvent,
    requestHeartbeat,
    runIsolatedAgentJob,
    onEvent,
  });
  try {
    await cron.start();
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(requestHeartbeat).toHaveBeenCalledOnce();
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(enqueueSystemEvent.mock.calls[0]?.[0]).toBe("run the replacement once");
    for (const jobs of await jobViews(cron)) {
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: job.id,
        enabled: false,
        state: { lastRunAtMs: now, lastRunStatus: "ok" },
      });
      expect(jobs[0]?.state.nextRunAtMs).toBeUndefined();
      expect(jobs[0]?.state.runningAtMs).toBeUndefined();
    }
    const finished = onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.action === "finished");
    expect(finished).toHaveLength(2);
    expect(finished).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: job.id,
          status: "error",
          error: "cron: job interrupted by gateway restart",
          runAtMs: interruptedAt,
        }),
        expect.objectContaining({ jobId: job.id, status: "ok", runAtMs: now }),
      ]),
    );
  } finally {
    cron.stop();
  }
});
