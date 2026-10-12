import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
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
  runCommandJob?: CronServiceDeps["runCommandJob"];
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

  it.for([
    { enabled: false, editSchedule: false },
    { enabled: false, editSchedule: true },
  ])(
    "preserves a queued pre-deadline occurrence unless its schedule changes (enabled=$enabled, editSchedule=$editSchedule)",
    async ({ enabled, editSchedule }, { signal }) => {
      const finished = createDeferred();
      const removed = createDeferred();
      const capacity = createQueueBlocker();
      let targetId: string | undefined;
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
      const options = {
        runIsolatedAgentJob,
        runCommandJob: capacity.runCommandJob,
        onEvent: (event: CronEvent) => {
          if (event.jobId !== targetId) {
            return;
          }
          if (event.action === "finished") {
            finished.resolve();
          }
          if (event.action === "removed") {
            removed.resolve();
          }
        },
      };
      let cron = createCron(options);

      let releaseBlockers: (() => Promise<void>) | undefined;

      try {
        await cron.start();
        cron.pauseScheduling();
        releaseBlockers = await capacity.occupy(cron, signal);
        const atMs = clock.clock.now() + 1_000;
        const job = await addOneShot({
          cron,
          name: "manual queued across deadline",
          atMs,
          enabled,
        });
        targetId = job.id;

        await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
          ok: true,
          enqueued: true,
        });
        expect((await cron.readJob(job.id))?.state.queuedAtMs).toEqual(expect.any(Number));
        clock.setTime(atMs + 1);
        await releaseBlockers();
        await withinTest(finished.promise, signal);
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
            await withinTest(removed.promise, signal);
          }
          await cron.status();
          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(editSchedule ? 1 : 2);
          expect((await loadCronStore(storePath)).jobs).toHaveLength(editSchedule ? 1 : 0);
        }
      } finally {
        await releaseBlockers?.();
        cron.stop();
      }
    },
  );

  it.for([
    { startOffsetMs: 1, editSchedule: false },
    { startOffsetMs: 1, editSchedule: true },
  ])(
    "retains only an unchanged occurrence when enabled during a queued manual run (start offset=$startOffsetMs, editSchedule=$editSchedule)",
    async ({ startOffsetMs, editSchedule }, { signal }) => {
      const payloadStarted = createDeferred();
      const releasePayload = createDeferred();
      const finished = createDeferred();
      const scheduledOccurrenceConsumed = createDeferred();
      const capacity = createQueueBlocker();
      let targetId: string | undefined;
      const runIsolatedAgentJob = vi
        .fn(async () => ({ status: "ok" as const, summary: "scheduled" }))
        .mockImplementationOnce(async () => {
          payloadStarted.resolve();
          await releasePayload.promise;
          return { status: "ok" as const, summary: "manual" };
        });
      const options = {
        runIsolatedAgentJob,
        runCommandJob: capacity.runCommandJob,
        onEvent: (event: CronEvent) => {
          if (event.jobId !== targetId) {
            return;
          }
          if (event.action === "finished") {
            finished.resolve();
          }
          if (event.action === "removed") {
            scheduledOccurrenceConsumed.resolve();
          }
        },
      };
      let cron = createCron(options);
      let releaseBlockers: (() => Promise<void>) | undefined;

      try {
        await cron.start();
        cron.pauseScheduling();
        releaseBlockers = await capacity.occupy(cron, signal);
        const atMs = clock.clock.now() + 1_000;
        const job = await addOneShot({
          cron,
          name: "enable while manual run crosses deadline",
          atMs,
          enabled: false,
        });
        targetId = job.id;
        await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
          ok: true,
          enqueued: true,
        });
        expect((await cron.readJob(job.id))?.state.queuedAtMs).toEqual(expect.any(Number));
        clock.setTime(atMs + startOffsetMs);
        await releaseBlockers();
        await withinTest(payloadStarted.promise, signal);
        clock.setTime(atMs + 10);
        if (editSchedule) {
          await cron.update(job.id, { schedule: { kind: "every", everyMs: 60_000 } });
          await cron.update(job.id, {
            schedule: { kind: "at", at: new Date(atMs).toISOString() },
          });
        }
        await cron.update(job.id, { enabled: true });
        releasePayload.resolve();
        await withinTest(finished.promise, signal);
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
          await withinTest(scheduledOccurrenceConsumed.promise, signal);
        }
        await cron.status();
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(editSchedule ? 1 : 2);
        expect((await loadCronStore(storePath)).jobs).toHaveLength(editSchedule ? 1 : 0);
      } finally {
        releasePayload.resolve();
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
