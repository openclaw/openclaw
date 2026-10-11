import { expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../test/helpers/cron/runtime-mutation.js";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStreamScheduleKey } from "./stream-schedule.js";
import type { CronJob } from "./types.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-run-queue-",
  fakeTimers: false,
});

function commandJob(id: string, nextRunAtMs = NOW + 60_000): CronJob {
  return {
    ...createDueIsolatedJob({ id, nowMs: NOW, nextRunAtMs }),
    agentId: "main",
    payload: { kind: "command", argv: ["synthetic", id] },
  };
}

it("force-runs a disabled job without consuming its paced slot", async () => {
  const { storePath } = await makeStorePath();
  const job = commandJob("disabled-force");
  job.enabled = false;
  job.state.pacedNextRunAtMs = job.state.nextRunAtMs;
  const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => NOW,
    storePath,
    cronEnabled: false,
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    runCommandJob,
  });
  try {
    expect(await cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
    expect(runCommandJob).toHaveBeenCalledOnce();
    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted).toMatchObject({
      enabled: false,
      state: {
        nextRunAtMs: NOW + 60_000,
        pacedNextRunAtMs: NOW + 60_000,
        lastRunStatus: "ok",
      },
    });
    expect(persisted?.state.queuedAtMs).toBeUndefined();
    expect(persisted?.state.runningAtMs).toBeUndefined();
  } finally {
    cron.stop();
    await cron.waitForIdle();
  }
});

it("shares capacity across timer, manual, stream, and consumed exit requests", async ({
  signal,
}) => {
  const { storePath } = await makeStorePath();
  const clock = createGatewaySchedulerClock(NOW);
  const release = createDeferred();
  const capacityFilled = createDeferred();
  const exitAccepted = createDeferred();
  const timerRequested = createDeferred();
  const blockers = Array.from({ length: 8 }, (_, index) => commandJob(`blocker-${index}`));
  const manual = commandJob("queued-manual");
  const timed = commandJob("queued-timer", NOW + 10_000);
  const exitSchedule = { kind: "on-exit" as const, command: "synthetic-watch" };
  const exit: CronJob = { ...commandJob("queued-exit"), schedule: exitSchedule, state: {} };
  const streamSchedule = { kind: "stream" as const, command: ["synthetic-stream"] };
  const stream: CronJob = {
    ...commandJob("queued-stream"),
    schedule: streamSchedule,
    payload: { kind: "agentTurn", message: "configured stream payload" },
    state: { streamSourceIdentity: "synthetic-source" },
  };
  await saveCronStore(storePath, {
    version: 1,
    jobs: [...blockers, manual, timed, stream, exit],
  });
  let active = 0;
  let peakActive = 0;
  let blockersStarted = 0;
  const executed: CronJob[] = [];
  const runCommandJob = vi.fn(async ({ job }: { job: CronJob }) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    try {
      if (job.id.startsWith("blocker-")) {
        blockersStarted += 1;
        if (blockersStarted === 8) {
          capacityFilled.resolve();
        }
        await release.promise;
      } else {
        executed.push(structuredClone(job));
      }
      return { status: "ok" as const };
    } finally {
      active -= 1;
    }
  });
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(clock.clock),
    nowMs: clock.clock.now,
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runCommandJob,
    runIsolatedAgentJob,
  });
  const pending: Array<Promise<unknown>> = [];
  const stopObserving = observeCronJobCommits(timed.id, (state) => {
    if (state.queuedAtMs !== undefined) {
      timerRequested.resolve();
    }
  });
  try {
    await cron.start();
    pending.push(...blockers.map((job) => cron.run(job.id, "force")));
    await withinTest(capacityFilled.promise, signal);

    const tick = Promise.resolve(clock.advanceBy(10_000));
    pending.push(tick);
    await withinTest(
      awaitGateBeforeSettlement(timerRequested.promise, tick, "timer did not queue its due job"),
      signal,
    );
    const manualAck = await cron.enqueueRun(manual.id, "force");
    expect(manualAck).toMatchObject({ ok: true, enqueued: true });
    const streamRun = cron.run(stream.id, "force", {
      payload: { kind: "agentTurn", message: "accepted stream payload" },
      streamBatch: "line one\nline two",
      streamScheduleKey: cronStreamScheduleKey(streamSchedule),
      streamSourceIdentity: "synthetic-source",
    });
    pending.push(streamRun);
    const exitRun = cron.runOnExit(exit.id, {
      schedule: exitSchedule,
      signal,
      commitGuard() {},
      onReserved: () => exitAccepted.resolve(),
      payload: () => ({ kind: "command", argv: ["synthetic", "accepted exit"] }),
    });
    pending.push(exitRun);
    await withinTest(
      awaitGateBeforeSettlement(exitAccepted.promise, exitRun, "exit was not accepted"),
      signal,
    );

    const queued = (await loadCronStore(storePath)).jobs;
    for (const job of [manual, timed, stream, exit]) {
      expect(queued.find((candidate) => candidate.id === job.id)?.state.queuedAtMs).toEqual(
        expect.any(Number),
      );
    }
    expect(queued.find((job) => job.id === exit.id)?.enabled).toBe(false);
    expect(executed).toEqual([]);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();

    release.resolve();
    await withinTest(Promise.all(pending), signal);
    if (!manualAck.ok || !("runId" in manualAck)) {
      throw new Error("Expected the accepted manual request ID");
    }
    expect(await cron.waitForManualRun(manualAck.runId, 60_000, signal)).toBe(true);
    expect(peakActive).toBe(8);
    expect(executed.map((job) => job.id).sort()).toEqual([exit.id, manual.id, timed.id].sort());
    expect(executed.find((job) => job.id === exit.id)).toMatchObject({
      enabled: false,
      payload: { kind: "command", argv: ["synthetic", "accepted exit"] },
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "accepted stream payload\n\nline one\nline two",
      }),
    );
    const persistedExit = (await loadCronStore(storePath)).jobs.find((job) => job.id === exit.id);
    expect(persistedExit).toMatchObject({ enabled: false, state: { lastRunStatus: "ok" } });
  } finally {
    release.resolve();
    stopObserving();
    await Promise.allSettled(pending);
    cron.stop();
    await cron.waitForIdle();
  }
});

it("retires a stale markerless receipt at startup so the job can run again", async () => {
  const { storePath } = await makeStorePath();
  const job = commandJob("markerless-receipt");
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const context = captureOpenClawStateWorkerContext();
  const receiptId = "cron:request:markerless-receipt";
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
  const requested = await executeOpenClawStateWorker(context, {
    type: "cron.requestRuns",
    input: {
      storeKey: storePath,
      nowMs: NOW,
      requests: [
        {
          jobId: job.id,
          receiptId,
          configRevision: resolveCronJobConfigRevision(job),
          mode: "force",
        },
      ],
    },
  });
  expect(requested.accepted).toHaveLength(1);
  const active = await executeOpenClawStateWorker(context, {
    type: "cron.drainQueue",
    input: {
      storeKey: storePath,
      nowMs: NOW,
      maxConcurrentRuns: 1,
      requests: [{ receiptId, mode: "force" }],
    },
  });
  expect(active.launches).toHaveLength(1);
  // Model a crash after job finalization but before the deferred receipt finish.
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      "UPDATE cron_jobs SET state_json = json_remove(state_json, '$.runningAtMs', '$.runningReceiptId') WHERE store_key = ? AND job_id = ?",
    ).run(storePath, job.id);
  });
  const readOldReceipt = () =>
    runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT receipt_id, status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receiptId),
    );
  expect(readOldReceipt()).toEqual({ receipt_id: receiptId, status: "running" });
  const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => NOW,
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    runCommandJob,
  });
  try {
    await cron.start();
    expect(readOldReceipt()).toEqual({ receipt_id: receiptId, status: "interrupted" });
    expect(runCommandJob).not.toHaveBeenCalled();
    expect(await cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
    expect(runCommandJob).toHaveBeenCalledOnce();
    expect(readOldReceipt()).toEqual({ receipt_id: receiptId, status: "interrupted" });
    expect((await loadCronStore(storePath)).jobs[0]?.state.lastRunStatus).toBe("ok");
  } finally {
    cron.stop();
    await cron.waitForIdle();
  }
});
