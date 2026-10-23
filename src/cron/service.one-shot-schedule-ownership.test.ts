import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronEvent, CronServiceDeps } from "./service/state.js";
import {
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  MIN_REFIRE_GAP_MS,
} from "./service/timer-execution-timeout.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
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

type IsolatedOutcome =
  | { status: "ok"; summary: string }
  | { status: "error"; error: string }
  | { status: "skipped"; error: string };

function createCron(params: {
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"];
  onEvent?: (event: CronEvent) => void;
}) {
  return new CronService({
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    ...params,
  });
}

async function blockCronLane() {
  const started = createDeferred();
  const release = createDeferred();
  clearCommandLane(CommandLane.Cron);
  setCommandLaneConcurrency(CommandLane.Cron, 1);
  const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  return { blocker, release };
}

async function addOneShot(params: {
  cron: CronService;
  name: string;
  atMs: number;
  id?: string;
  deleteAfterRun?: boolean;
  enabled?: boolean;
}) {
  return await params.cron.add({
    ...(params.id === undefined ? {} : { id: params.id }),
    name: params.name,
    enabled: params.enabled ?? true,
    ...(params.deleteAfterRun === undefined ? {} : { deleteAfterRun: params.deleteAfterRun }),
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "verify one-shot schedule ownership" },
    delivery: { mode: "none" },
  });
}

async function expectFutureOneShot(params: {
  cron: CronService;
  jobId: string;
  atMs: number;
  status: IsolatedOutcome["status"];
  enabled?: boolean;
}) {
  const expected = {
    id: params.jobId,
    enabled: params.enabled ?? true,
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    state: {
      lastRunStatus: params.status,
      lastStatus: params.status,
    },
  };
  for (const jobs of [
    await params.cron.list({ includeDisabled: true }),
    (await loadCronStore(storePath)).jobs,
  ]) {
    const job = jobs.find((entry) => entry.id === params.jobId);
    expect(job).toMatchObject(expected);
    expect(job?.state.nextRunAtMs).toBe(params.enabled === false ? undefined : params.atMs);
    expect(job?.state.runningAtMs).toBeUndefined();
  }
  const history = readCronRunHistoryPageForTests({
    storeKey: cronStoreKey(storePath),
    jobId: params.jobId,
  });
  expect(history.entries).toEqual([
    expect.objectContaining({
      status: params.status,
      ...(params.status === "ok" ? { completionStatus: "succeeded" } : {}),
    }),
  ]);
}

describe("cron one-shot schedule ownership", () => {
  it.each([
    { mode: "direct", deleteAfterRun: false },
    { mode: "queued", deleteAfterRun: true },
  ] as const)(
    "does not finalize an active $mode run into a removed and recreated one-shot (deleteAfterRun=$deleteAfterRun)",
    async ({ mode, deleteAfterRun }) => {
      const started = createDeferred();
      const release = createDeferred<{ status: "ok"; summary: string }>();
      const finished = createDeferred();
      const events: CronEvent[] = [];
      const cron = createCron({
        runIsolatedAgentJob: vi.fn(async () => {
          started.resolve();
          return await release.promise;
        }),
        onEvent: (event) => {
          events.push(event);
          if (event.action === "finished") {
            finished.resolve();
          }
        },
      });

      try {
        await cron.start();
        const atMs = clock.clock.now() + 60 * 60_000;
        const original = await addOneShot({
          cron,
          id: `removed-active-${mode}-${deleteAfterRun}`,
          name: "removed original one-shot",
          atMs,
          deleteAfterRun,
        });
        const directRun = mode === "direct" ? cron.run(original.id, "force") : undefined;
        if (mode === "queued") {
          await expect(cron.enqueueRun(original.id, "force")).resolves.toMatchObject({
            ok: true,
            enqueued: true,
          });
        }
        await started.promise;

        await expect(cron.remove(original.id)).resolves.toEqual({
          ok: true,
          removed: true,
          activeRunCancellationRequested: true,
        });
        await addOneShot({
          cron,
          id: original.id,
          name: "independent replacement one-shot",
          atMs,
          deleteAfterRun,
        });

        release.resolve({ status: "ok", summary: "original run finished" });
        if (directRun) {
          await expect(directRun).resolves.toEqual({ ok: true, ran: true });
        } else {
          await finished.promise;
        }
        await cron.status();

        for (const jobs of [
          await cron.list({ includeDisabled: true }),
          (await loadCronStore(storePath)).jobs,
        ]) {
          const replacement = jobs.find((job) => job.id === original.id);
          expect(replacement).toMatchObject({
            id: original.id,
            name: "independent replacement one-shot",
            enabled: true,
            deleteAfterRun,
            state: { nextRunAtMs: atMs },
          });
          expect(replacement?.state.lastRunAtMs).toBeUndefined();
          expect(replacement?.state.lastRunStatus).toBeUndefined();
          expect(replacement?.state.lastStatus).toBeUndefined();
          expect(replacement?.state.runningAtMs).toBeUndefined();
        }

        // Removal aborts the in-flight run: both direct and queued callers need
        // one durable, visible terminal result for the original run.
        const finishedEvents = events.filter(
          (event) => event.action === "finished" && event.jobId === original.id,
        );
        expect(finishedEvents).toEqual([
          expect.objectContaining({
            status: "error",
            error: "Cron job removed by operator.",
            deliveryStatus: "not-requested",
            job: expect.objectContaining({ name: "removed original one-shot" }),
          }),
        ]);
        const history = readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(storePath),
          jobId: original.id,
        });
        expect(history.entries).toEqual([
          expect.objectContaining({
            status: "error",
            error: "Cron job removed by operator.",
            deliveryStatus: "not-requested",
            runId: finishedEvents[0]?.runId,
          }),
        ]);
        const receipts = openOpenClawStateDatabase()
          .db.prepare(
            "SELECT receipt_id AS receiptId, status, error_text AS error FROM cron_run_receipts WHERE store_key = ? AND job_id = ?",
          )
          .all(cronStoreKey(storePath), original.id) as Array<{
          receiptId: string;
          status: string;
          error: string | null;
        }>;
        expect(receipts).toEqual([
          expect.objectContaining({
            status: "error",
            error: "Cron job removed by operator.",
          }),
        ]);
      } finally {
        release.resolve({ status: "ok", summary: "original run finished" });
        cron.stop();
      }
    },
  );

  it.each([
    { enabled: false, editSchedule: false },
    { enabled: false, editSchedule: true },
  ])(
    "preserves a queued pre-deadline occurrence unless its schedule changes (enabled=$enabled, editSchedule=$editSchedule)",
    async ({ enabled, editSchedule }) => {
      const finished = createDeferred();
      const removed = createDeferred();
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
      const options = {
        runIsolatedAgentJob,
        onEvent: (event: CronEvent) => {
          if (event.action === "finished") {
            finished.resolve();
          }
          if (event.action === "removed") {
            removed.resolve();
          }
        },
      };
      let cron = createCron(options);

      const { blocker, release: releaseBlocker } = await blockCronLane();

      try {
        await cron.start();
        cron.pauseScheduling();
        const atMs = clock.clock.now() + 1_000;
        const job = await addOneShot({
          cron,
          name: "manual queued across deadline",
          atMs,
          enabled,
        });

        await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
          ok: true,
          enqueued: true,
        });
        clock.setTime(atMs + 1);
        releaseBlocker.resolve();
        await blocker;
        await finished.promise;
        await cron.status();

        await expectFutureOneShot({
          cron,
          jobId: job.id,
          atMs,
          status: "ok",
          enabled,
        });
        if (!enabled) {
          cron.stop();
          cron = createCron(options);
          cron.pauseScheduling();
          await cron.start();
          await expectFutureOneShot({
            cron,
            jobId: job.id,
            atMs,
            status: "ok",
            enabled,
          });
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
          await clock.advanceBy(MIN_REFIRE_GAP_MS);
          if (!editSchedule) {
            await removed.promise;
          }
          await cron.status();
          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(editSchedule ? 1 : 2);
          expect((await loadCronStore(storePath)).jobs).toHaveLength(editSchedule ? 1 : 0);
        }
      } finally {
        releaseBlocker.resolve();
        await blocker;
        cron.stop();
        clearCommandLane(CommandLane.Cron);
      }
    },
  );

  it.each([
    { startOffsetMs: 1, editSchedule: false },
    { startOffsetMs: 1, editSchedule: true },
  ])(
    "retains only an unchanged occurrence when enabled during a queued manual run (start offset=$startOffsetMs, editSchedule=$editSchedule)",
    async ({ startOffsetMs, editSchedule }) => {
      const payloadStarted = createDeferred();
      const releasePayload = createDeferred();
      const scheduledOccurrenceConsumed = createDeferred();
      const runIsolatedAgentJob = vi
        .fn(async () => ({ status: "ok" as const, summary: "scheduled" }))
        .mockImplementationOnce(async () => {
          payloadStarted.resolve();
          await releasePayload.promise;
          return { status: "ok" as const, summary: "manual" };
        });
      const options = {
        runIsolatedAgentJob,
        onEvent: (event: CronEvent) => {
          if (event.action === "removed") {
            scheduledOccurrenceConsumed.resolve();
          }
        },
      };
      let cron = createCron(options);
      const { blocker, release: releaseBlocker } = await blockCronLane();

      try {
        await cron.start();
        cron.pauseScheduling();
        const atMs = clock.clock.now() + 1_000;
        const job = await addOneShot({
          cron,
          name: "enable while manual run crosses deadline",
          atMs,
          enabled: false,
        });
        await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
          ok: true,
          enqueued: true,
        });
        clock.setTime(atMs + startOffsetMs);
        releaseBlocker.resolve();
        await blocker;
        await payloadStarted.promise;
        clock.setTime(atMs + 10);
        if (editSchedule) {
          await cron.update(job.id, { schedule: { kind: "every", everyMs: 60_000 } });
          await cron.update(job.id, {
            schedule: { kind: "at", at: new Date(atMs).toISOString() },
          });
        }
        await cron.update(job.id, { enabled: true });
        releasePayload.resolve();
        // Joining the lane successor also joins the manual run's final ownership cleanup.
        await enqueueCommandInLane(CommandLane.Cron, async () => {});
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
        await expectFutureOneShot({
          cron,
          jobId: job.id,
          atMs,
          status: "ok",
        });

        cron.stop();
        cron = createCron(options);
        await cron.start();
        if (editSchedule) {
          expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeUndefined();
        } else {
          expect(cron.getJob(job.id)?.state.nextRunAtMs).toEqual(expect.any(Number));
        }
        await clock.advanceBy(
          DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS + MIN_REFIRE_GAP_MS,
        );
        if (!editSchedule) {
          await scheduledOccurrenceConsumed.promise;
        }
        await enqueueCommandInLane(CommandLane.Cron, async () => {});
        await cron.status();
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(editSchedule ? 1 : 2);
        expect((await loadCronStore(storePath)).jobs).toHaveLength(editSchedule ? 1 : 0);
      } finally {
        releaseBlocker.resolve();
        releasePayload.resolve();
        await blocker;
        await enqueueCommandInLane(CommandLane.Cron, async () => {});
        cron.stop();
        clearCommandLane(CommandLane.Cron);
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
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath,
      cronEnabled: true,
      log: logger,
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
      for (const jobs of [
        await cron.list({ includeDisabled: true }),
        (await loadCronStore(storePath)).jobs,
      ]) {
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          id: job.id,
          enabled: false,
          state: {
            lastRunAtMs: now,
            lastRunStatus: "ok",
          },
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
});

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
    const started = createDeferred();
    const release = createDeferred();
    const runIsolatedAgentJob = vi
      .fn<CronServiceDeps["runIsolatedAgentJob"]>()
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return { status: "ok", summary: "CI is pending", nextCheck: { delayMs } };
      })
      .mockResolvedValue({ status: "ok", summary: "CI passed" });
    const jobViews = async (service: CronService) => [
      await service.list({ includeDisabled: true }),
      (await loadCronStore(storePath)).jobs,
    ];
    let cron = createCron({ runIsolatedAgentJob });
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
      await withinTest(started.promise, signal);
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
      release.resolve();
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
        // Release adaptation: an A->B->A schedule edit during a run restores the authored
        // slot on this line with or without a proposal; the edit still retires the rearm.
        expect(jobs[0]?.state.nextRunAtMs).toBe(
          edit === "none"
            ? continuationAtMs
            : edit === "reschedule"
              ? editedAtMs
              : edit === "schedule round trip"
                ? atMs
                : undefined,
        );
      }
      if (edit !== "none") {
        return;
      }
      cron.stop();
      const restartAtMs = continuationAtMs + (overdueRestart ? 1_000 : -1_000);
      clock.setTime(restartAtMs);
      cron = createCron({ runIsolatedAgentJob });
      cron.pauseScheduling();
      await cron.start();
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      // Release adaptation: startup catch-up staggers every missed agent turn on this
      // line; the rearmed continuation keeps its job and runs at the deferred slot.
      const resumedAtMs = overdueRestart
        ? restartAtMs + DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS
        : continuationAtMs;
      expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(resumedAtMs);
      clock.setTime(resumedAtMs + 2_000);
      await expect(cron.run(job.id, "due")).resolves.toMatchObject({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
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
      release.resolve();
      cron.stop();
    }
  },
);
