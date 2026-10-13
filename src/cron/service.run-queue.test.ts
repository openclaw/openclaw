import { expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../test/helpers/cron/runtime-mutation.js";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as stateRead from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { CronService } from "./service.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { drainCronRunQueue, stopCronRunQueue, waitForCronRunQueue } from "./service/run-queue.js";
import { runCronSchedulerMaintenance } from "./service/scheduler-maintenance.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { createCronScheduledRunId } from "./store/run-request-id.js";
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

it.for(["complete", "cancel", "lost-result"] as const)(
  "handles a same-store on-exit predecessor without joining unrelated work: %s",
  async (outcome, { signal }) => {
    const { storePath } = await makeStorePath();
    const schedule = { kind: "on-exit", command: "synthetic-exit" } as const;
    const job = { ...commandJob("exit-wait"), schedule };
    const unrelated = commandJob("unrelated-wait");
    await saveCronStore(storePath, { version: 1, jobs: [job, unrelated] });
    const targetEntered = createDeferred();
    const unrelatedEntered = createDeferred();
    const releaseTarget = createDeferred();
    const releaseUnrelated = createDeferred();
    const accepted = createDeferred();
    let targetRuns = 0;
    const runCommandJob = vi.fn(async ({ job: current }: { job: CronJob }) => {
      if (current.id === unrelated.id) {
        unrelatedEntered.resolve();
        await releaseUnrelated.promise;
      } else if (++targetRuns === 1) {
        targetEntered.resolve();
        await releaseTarget.promise;
      }
      return { status: "ok" as const };
    });
    const createService = () =>
      new CronService({
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
    const cron = createService();
    const sibling = createService();
    const controller = new AbortController();
    const pending: Array<Promise<unknown>> = [];
    let restoreFinalization: (() => void) | undefined;
    try {
      const first = cron.run(job.id, "force");
      void first.catch(() => {});
      const other = cron.run(unrelated.id, "force");
      pending.push(first, other);
      await withinTest(Promise.all([targetEntered.promise, unrelatedEntered.promise]), signal);
      if (outcome === "lost-result") {
        const execute = stateWorker.executeOpenClawStateWorker;
        const finalization = vi
          .spyOn(stateWorker, "executeOpenClawStateWorker")
          .mockImplementation((context, command) =>
            command.type === "cron.finalizeRuns"
              ? Promise.reject(new Error("synthetic terminal write failure"))
              : execute(context, command),
          );
        restoreFinalization = () => finalization.mockRestore();
      }
      const exit = sibling.runOnExit(job.id, {
        schedule,
        signal: controller.signal,
        commitGuard() {},
        onReserved: () => accepted.resolve(),
      });
      pending.push(exit);
      if (outcome === "cancel") {
        controller.abort();
        await expect(withinTest(exit, signal)).resolves.toMatchObject({
          ok: true,
          ran: false,
          reason: "stopped",
        });
        releaseTarget.resolve();
        await withinTest(first, signal);
        expect(targetRuns).toBe(1);
      } else if (outcome === "lost-result") {
        releaseTarget.resolve();
        await expect(withinTest(first, signal)).rejects.toThrow("synthetic terminal write failure");
        await expect(withinTest(exit, signal)).resolves.toMatchObject({
          ok: true,
          ran: false,
          reason: "already-running",
        });
        expect(targetRuns).toBe(1);
      } else {
        releaseTarget.resolve();
        await withinTest(accepted.promise, signal);
        await expect(withinTest(exit, signal)).resolves.toMatchObject({ ok: true, ran: true });
        expect(targetRuns).toBe(2);
      }
      expect((await cron.readJob(unrelated.id))?.state.runningAtMs).toBeDefined();
    } finally {
      controller.abort();
      restoreFinalization?.();
      releaseTarget.resolve();
      releaseUnrelated.resolve();
      await Promise.allSettled(pending);
      cron.stop();
      sibling.stop();
      await Promise.all([cron.waitForIdle(), sibling.waitForIdle()]);
    }
  },
);

it("keeps owned running work out of recovery and queue database polling", async ({ signal }) => {
  const { storePath } = await makeStorePath();
  const job = commandJob("owned-running");
  const entered = createDeferred();
  const release = createDeferred();
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => NOW,
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    runCommandJob: async () => {
      entered.resolve();
      await release.promise;
      return { status: "ok" };
    },
  });
  let completion: Promise<unknown> | undefined;
  try {
    await cron.start();
    completion = cron.run(job.id, "force");
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, completion, "owned run did not start"),
      signal,
    );
    await cron.start();
    const running = await cron.readJob(job.id);
    expect(running).toMatchObject({
      state: { runningAtMs: NOW },
    });
    expect(running?.state.lastError).toBeUndefined();
    // Consume the queue's committed publication once, then the loaded owner is current.
    await runCronSchedulerMaintenance(state);
    await drainCronRunQueue(state);
    const reads = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
    const writes = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
    try {
      await runCronSchedulerMaintenance(state);
      await drainCronRunQueue(state);
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      writes.mockRestore();
    }
  } finally {
    release.resolve();
    await completion;
    cron.stop();
    await cron.waitForIdle();
  }
});

it("joins a running job before restarting after scheduler cleanup fails", async ({ signal }) => {
  const { storePath } = await makeStorePath();
  const job = commandJob("restart-after-cleanup");
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const entered = createDeferred();
  const release = createDeferred();
  const cleanupFailed = createDeferred();
  const runCommandJob = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { status: "ok" as const };
  });
  const { cron, state } = createCronServiceWithStateForTest({
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
  const pending: Array<Promise<unknown>> = [];
  let restoreStop: (() => void) | undefined;
  try {
    await cron.start();
    const running = cron.run(job.id, "force");
    pending.push(running);
    await withinTest(entered.promise, signal);
    const stopScope = state.schedulerScope.stop.bind(state.schedulerScope);
    const stop = vi.spyOn(state.schedulerScope, "stop").mockImplementationOnce(async () => {
      await stopScope();
      cleanupFailed.resolve();
      throw new Error("synthetic scheduler cleanup failure");
    });
    restoreStop = () => stop.mockRestore();
    cron.stop();
    const restarting = cron.start();
    pending.push(restarting);
    void restarting.catch(() => {});
    await withinTest(cleanupFailed.promise, signal);
    expect(state.stopped).toBe(true);
    release.resolve();
    await withinTest(Promise.all([running, restarting]), signal);
    expect(await cron.readJob(job.id)).toMatchObject({ state: { lastRunStatus: "ok" } });
    expect(logger.warn).toHaveBeenCalledWith(
      { errors: ["Error: synthetic scheduler cleanup failure"] },
      "cron: shutdown left work for recovery",
    );
    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(runCommandJob).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    restoreStop?.();
    await Promise.allSettled(pending);
    cron.stop();
    await cron.waitForIdle();
  }
});

it("force-runs a disabled job while scheduling is paused without consuming its paced slot", async () => {
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
    cron.pauseScheduling();
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

it("shares capacity across sibling services for timer, manual, stream, and consumed exit requests", async ({
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
  const disabled = commandJob("queued-disabled");
  const removed = commandJob("queued-removed");
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
    jobs: [...blockers, manual, disabled, removed, timed, stream, exit],
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
  const createService = () =>
    createCronServiceWithStateForTest({
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
  const { cron, state } = createService();
  const { cron: sibling } = createService();
  sibling.pauseScheduling();
  const pending: Array<Promise<unknown>> = [];
  const stopObserving = observeCronJobCommits(timed.id, (runtime) => {
    if (runtime.queuedAtMs !== undefined) {
      timerRequested.resolve();
    }
  });
  try {
    await cron.start();
    pending.push(...blockers.map((job) => cron.run(job.id, "force")));
    await withinTest(capacityFilled.promise, signal);

    await clock.advanceBy(10_000);
    const tick = onTimer(state);
    pending.push(tick);
    await withinTest(
      awaitGateBeforeSettlement(timerRequested.promise, tick, "timer did not queue its due job"),
      signal,
    );
    const manualAck = await cron.enqueueRun(manual.id, "force");
    expect(manualAck).toMatchObject({ ok: true, enqueued: true });
    for (const [job, remove] of [
      [disabled, false],
      [removed, true],
    ] as const) {
      const ack = await sibling.enqueueRun(job.id, "force");
      if (!ack.ok || !("runId" in ack)) {
        throw new Error("Expected a queued request before cancellation");
      }
      if (remove) {
        await cron.remove(job.id);
      } else {
        await cron.update(job.id, { enabled: false });
      }
      expect(await sibling.waitForManualRun(ack.runId, 60_000, signal)).toBe(true);
      expect(active).toBe(8);
      expect(executed).toEqual([]);
    }
    const streamRun = sibling.run(stream.id, "force", {
      payload: { kind: "agentTurn", message: "accepted stream payload" },
      streamBatch: "line one\nline two",
      streamScheduleKey: cronStreamScheduleKey(streamSchedule),
      streamSourceIdentity: "synthetic-source",
    });
    pending.push(streamRun);
    const exitRun = sibling.runOnExit(exit.id, {
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
      expect(
        queued.find((candidate) => candidate.id === job.id)?.state.queuedAtMs,
        `${job.id}: queued run remains behind shared capacity`,
      ).toEqual(expect.any(Number));
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
    expect(executed.map((job) => job.id).toSorted()).toEqual(
      [exit.id, manual.id, timed.id].toSorted(),
    );
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
    sibling.stop();
    await cron.waitForIdle();
    await sibling.waitForIdle();
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

it("contains recovered scheduled launch failures without an unhandled rejection", async () => {
  const { storePath } = await makeStorePath();
  const job = commandJob("recovered-launch-failure", NOW);
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const context = captureOpenClawStateWorkerContext();
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
  const receiptId = createCronScheduledRunId(storePath, job.id, NOW);
  const requested = await executeOpenClawStateWorker(context, {
    type: "cron.requestRuns",
    input: {
      storeKey: storePath,
      nowMs: NOW,
      defaultAgentId: "main",
      requests: [
        {
          jobId: job.id,
          receiptId,
          configRevision: resolveCronJobConfigRevision(job),
          mode: "scheduled",
          scheduledSlotMs: NOW,
          scheduleOwnershipAtMs: NOW,
        },
      ],
    },
  });
  expect(requested.accepted).toHaveLength(1);
  const failure = new Error("scheduler owner is retired");
  const scheduler = createTestGatewayScheduler();
  const state = createCronServiceState({
    scheduler,
    nowMs: () => NOW,
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runSchedulerOwned: async () => {
      throw failure;
    },
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  // Durable requests survive restart; this new owner has no caller completion to observe.
  state.store = await loadCronStore(storePath);
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", observe);
  try {
    await drainCronRunQueue(state);
    await waitForCronRunQueue(state);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(unhandled).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      { jobId: job.id, err: String(failure) },
      "cron: queued launch failed",
    );
    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted?.state.queuedAtMs).toBeUndefined();
    expect(persisted?.state.runningAtMs).toBeUndefined();
  } finally {
    process.off("unhandledRejection", observe);
    state.stopped = true;
    await stopCronRunQueue(state);
    await waitForCronRunQueue(state);
    await scheduler.stop();
  }
});
