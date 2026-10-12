import { once } from "node:events";
import { deserialize } from "node:v8";
import { MessageChannel, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../../test/helpers/cron/runtime-mutation.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { startSqliteConcurrentWriter } from "../../infra/sqlite-concurrent-writer.test-support.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import {
  advanceCronActiveJobGeneration,
  clearCronJobActive,
  isCronJobActive,
  markCronJobActive,
} from "../active-jobs.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import { CronService } from "../service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import * as cronStore from "../store.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  finishCronRunReceiptAsync,
  finishCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  inspectActiveCronRunReceipt,
  makeCronRecoveryJob,
} from "../store/run-receipt-store.test-support.js";
import { prepareCronRunReceiptWriteSchema } from "../store/run-receipt-write-admission.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { locked } from "./locked.js";
import { start, stop } from "./ops-lifecycle.js";
import { remove, update } from "./ops-mutations.js";
import { run } from "./ops-run.js";
import { ensureLoadedForRead } from "./ops-shared.js";
import {
  claimCronRecoveryReceipt,
  makeCronRecoveryState,
  observeCronTimerAdmissions,
} from "./run-recovery.test-support.js";
import * as serviceState from "./state.js";
import { createCronServiceState, type CronEvent, type CronServiceDeps } from "./state.js";
import { MIN_REFIRE_GAP_MS } from "./timer-execution-timeout.js";
import { onTimer } from "./timer.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-recovery-lifecycle-" });

describe("one-shot recovery", () => {
  it.each([
    { mode: "retired", status: "ok" },
    { mode: "rescheduled", status: "ok" },
    { mode: "manual", status: "error" },
    { mode: "manual-delayed-force", status: "ok" },
    { mode: "manual-replaced", status: "ok" },
    { mode: "manual-write-failure", status: "ok" },
    { mode: "manual-write-failure-live", status: "error" },
    { mode: "manual-removed", status: "skipped" },
  ] as const)(
    "does not replay a $mode run that finishes as $status after stopping",
    async ({ mode, status }) => {
      const { storePath } = await makeStorePath();
      const nowMs = Date.now();
      const atMs = nowMs;
      const manual = mode.startsWith("manual");
      const writeFailure = mode.startsWith("manual-write-failure");
      const job: CronJob = {
        id: "shutdown-one-shot",
        agentId: "alpha",
        name: "shutdown one-shot",
        enabled: true,
        deleteAfterRun: !writeFailure,
        createdAtMs: nowMs - 1,
        updatedAtMs: nowMs - 1,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "command", argv: ["true"] },
        delivery: { mode: "none" },
        state: { nextRunAtMs: atMs },
      };
      if (mode === "manual" && status === "error") {
        job.failureAlert = { after: 1, cooldownMs: 60_000, channel: "last" };
      }
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const failureDatabase = writeFailure ? openOpenClawStateDatabase().db : undefined;
      const started = createDeferred();
      const completion = createDeferred<{ status: CronRunStatus; error?: string }>();
      const runCommandJob = vi.fn<NonNullable<CronServiceDeps["runCommandJob"]>>(async () => {
        started.resolve();
        return completion.promise;
      });
      const onEvent = vi.fn();
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const freshState = (clock = createGatewaySchedulerClock(nowMs)) =>
        createCronServiceState({
          storePath,
          cronEnabled: true,
          log: logger,
          scheduler: createTestGatewayScheduler(clock.clock),
          nowMs: clock.clock.now,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          runCommandJob,
          onEvent,
          sendCronFailureAlert,
        });
      const first = freshState();
      const startup = manual
        ? run(
            first,
            job.id,
            mode === "manual-delayed-force" ? "force" : undefined,
            mode === "manual-delayed-force" ? { scheduleOwnershipAtMs: nowMs - 1 } : undefined,
          )
        : start(first);
      const settledStartup = startup.then(
        () => undefined,
        (error: unknown) => error,
      );
      let successor: CronRunReceiptHandle | undefined;
      let successorMarker: ReturnType<typeof markCronJobActive>;
      try {
        await started.promise;
        const admittedReceipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
        if (mode === "manual-removed") {
          const entered = createDeferred();
          const unblock = createDeferred();
          const blocker = locked(first, async () => {
            entered.resolve();
            await unblock.promise;
          });
          await entered.promise;
          const removal = remove(first, job.id);
          const queuedRemoval = first.op;
          completion.resolve({ status });
          try {
            // Queue finalization behind removal, after its first removed check.
            await vi.waitFor(() => expect(first.op).not.toBe(queuedRemoval));
          } finally {
            unblock.resolve();
            await blocker;
            await removal;
          }
        }
        if (mode === "rescheduled") {
          // A separate service owns the edit; the finishing service must reload
          // its schedule fence rather than delete the replacement on success.
          const editor = freshState();
          try {
            await update(editor, job.id, {
              schedule: { kind: "at", at: new Date(nowMs + 60_000).toISOString() },
            });
          } finally {
            stop(editor);
          }
        }
        stop(first);
        if (mode === "retired" || (manual && mode !== "manual-write-failure-live")) {
          advanceCronActiveJobGeneration();
        }
        failureDatabase?.exec(`
          CREATE TRIGGER reject_manual_terminal_row
          BEFORE UPDATE ON cron_jobs
          WHEN NEW.job_id = 'shutdown-one-shot'
            AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL
          BEGIN
            SELECT RAISE(ABORT, 'manual row unavailable');
          END;
        `);
        if (mode === "manual-replaced") {
          const previous = inspectActiveCronRunReceipt({ storePath, jobId: job.id })!;
          // Simulate an authoritative replacement while the retired caller still
          // holds its result; process-local settlement cannot grant it ownership.
          runOpenClawStateWriteTransaction(({ db }) =>
            finishCronRunReceiptInDatabase({
              database: db,
              receiptSchema: prepareCronRunReceiptWriteSchema(db),
              handle: previous,
              status: "superseded",
              finishedAtMs: nowMs,
            }),
          );
          const prepared = prepareCronRunReceiptClaim({
            observed: undefined,
            storePath,
            job,
            agentId: "alpha",
            startedAtMs: nowMs,
          });
          successor = runOpenClawStateWriteTransaction(({ db }) =>
            claimCronRunReceiptInDatabaseForTest({
              database: db,
              prepared,
              resolveAgentId: () => "alpha",
            }),
          );
          successorMarker = markCronJobActive(job.id);
        }
        completion.resolve({ status, error: status === "error" ? "command failed" : undefined });
        if (writeFailure) {
          expect(await settledStartup).toMatchObject({
            message: expect.stringContaining("manual row unavailable"),
          });
          failureDatabase?.exec("DROP TRIGGER reject_manual_terminal_row");
          expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toMatchObject({
            receiptId: admittedReceipt?.receiptId,
          });
        } else {
          expect(await settledStartup).toBeUndefined();
        }
        if (mode === "manual" && status === "error") {
          await vi.waitFor(() => expect(sendCronFailureAlert).toHaveBeenCalledOnce());
        }
        const finished = onEvent.mock.calls.filter(([event]) => event.action === "finished");
        if (mode === "manual-removed") {
          expect(finished).toHaveLength(1);
          expect(
            readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
              .entries,
          ).toHaveLength(1);
          expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
          expect(isCronJobActive(job.id)).toBe(false);
        } else {
          expect(finished).toEqual([]);
        }
        if (mode === "manual-delayed-force") {
          expect((await loadCronStore(storePath)).jobs).toMatchObject([
            { enabled: true, state: { nextRunAtMs: atMs, forcePreservedNextRunAtMs: atMs } },
          ]);
        }
        for (let restart = 0; restart < 3; restart += 1) {
          const clock = createGatewaySchedulerClock(nowMs);
          const next = freshState(clock);
          try {
            await start(next);
            if (mode === "manual-delayed-force") {
              await clock.advanceBy(MIN_REFIRE_GAP_MS);
              expect(runCommandJob).toHaveBeenCalledTimes(2);
              expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBeUndefined();
              expect(next.activeTimerTicks).toBe(0);
            }
            // A force run reserved before the slot borrows it; once due, its
            // distinct scheduled occurrence still runs exactly once.
            expect(runCommandJob).toHaveBeenCalledTimes(mode === "manual-delayed-force" ? 2 : 1);
            const jobs = (await loadCronStore(storePath)).jobs;
            if (mode === "manual-removed") {
              expect(jobs).toHaveLength(0);
              continue;
            }
            if (successor) {
              expect(jobs[0]?.state.runningAtMs).toBe(nowMs);
              expect(jobs[0]?.state.lastRunStatus).toBeUndefined();
              expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })?.receiptId).toBe(
                successor.receiptId,
              );
              expect(isCronJobActive(job.id)).toBe(true);
              continue;
            }
            expect(jobs[0]?.state.runningAtMs).toBeUndefined();
            if (mode === "rescheduled") {
              expect(jobs).toMatchObject([
                {
                  enabled: true,
                  state: {
                    lastRunStatus: status,
                    nextRunAtMs: nowMs + 60_000,
                    scheduleActivatedAtMs: nowMs,
                  },
                },
              ]);
            } else if (status === "ok" && !writeFailure) {
              expect(jobs).toHaveLength(0);
            } else {
              expect(jobs).toMatchObject([{ enabled: false, state: { lastRunStatus: status } }]);
              expect(jobs[0]?.state.startupCatchupAtMs).toBeUndefined();
              expect(jobs[0]?.state.nextRunAtMs).toBeUndefined();
            }
          } finally {
            stop(next);
          }
        }
      } finally {
        stop(first);
        completion.resolve({ status });
        await settledStartup;
        failureDatabase?.exec("DROP TRIGGER IF EXISTS reject_manual_terminal_row");
        if (successor) {
          await finishCronRunReceiptAsync({
            handle: successor,
            status: "skipped",
            finishedAtMs: nowMs,
          });
          clearCronJobActive(job.id, successorMarker);
        }
      }
    },
  );
});

it("keeps reads responsive and finishes a dispatched repair after the scheduler stops", async () => {
  const { storePath } = await makeStorePath();
  const nowMs = Date.now();
  const jobs = Array.from({ length: 66 }, (_, index) => {
    const job = makeCronRecoveryJob(`job-${index}`, nowMs - 100);
    delete job.state.runningAtMs;
    job.enabled = index < 64;
    job.state.nextRunAtMs = nowMs + 86_400_000;
    return job;
  });
  await writeCronStoreSnapshot({ storePath, jobs });
  let state: serviceState.CronServiceState | undefined;
  const createState = serviceState.createCronServiceState;
  const capture = vi.spyOn(serviceState, "createCronServiceState").mockImplementation((deps) => {
    state = createState(deps);
    return state;
  });
  const onEvent = vi.fn();
  const runner = vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    defaultAgentId: "alpha",
    isAgentAvailable: () => true,
    nowMs: () => nowMs,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: runner,
    runCommandJob: runner,
    onEvent,
  });
  capture.mockRestore();
  if (!state) {
    throw new Error("Expected the service state");
  }
  const scheduler = state;
  const receipts: CronRunReceiptHandle[] = [];
  let writer: ReturnType<typeof startSqliteConcurrentWriter> | undefined;
  let pending: Promise<void> | undefined;
  let watchdogReleased = false;
  let watchdog: AbortSignal | undefined;
  const releaseStuckWriter = () => {
    watchdogReleased = true;
    void writer?.stop();
  };
  const posted = createDeferred();
  // oxlint-disable-next-line typescript/unbound-method -- call retains the observed Worker receiver.
  const nativePost = Worker.prototype.postMessage;
  const observe = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (isRecord(command) && command.type === "cron.repairRun") {
        posted.resolve();
      }
    }
    return nativePost.call(this, request, transferList);
  });
  try {
    await cron.start();
    for (const job of jobs.slice(0, 16)) {
      const startedAtMs = nowMs - 100;
      const prepared = prepareCronRunReceiptClaim({
        observed: undefined,
        storePath,
        job,
        agentId: "alpha",
        startedAtMs,
      });
      const receipt = runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabaseForTest({
          database: db,
          prepared,
          resolveAgentId: () => "alpha",
        }),
      );
      receipts.push(receipt);
      job.state.runningAtMs = startedAtMs;
      job.state.runningReceiptId = receipt.receiptId;
    }
    await writeCronStoreSnapshot({ storePath, jobs });
    const baseline = await cron.listPage({ limit: 50 });
    const database = openOpenClawStateDatabase();
    database.db.exec("CREATE TABLE writes (id INTEGER PRIMARY KEY)");
    writer = startSqliteConcurrentWriter(database.path, "WAL");
    await writer.waitFor("ready");
    expect(await writer.holdTransaction()).toMatchObject({ transaction: true });
    // Cleanup only: a regressed blocking read must not strand the independent writer.
    watchdog = AbortSignal.timeout(15_000);
    watchdog.addEventListener("abort", releaseStuckWriter, { once: true });
    pending = onTimer(scheduler);
    const pages = await Promise.all([cron.listPage({ limit: 50 }), cron.listPage({ limit: 50 })]);
    await pending;
    expect(watchdogReleased).toBe(false);
    expect(pages).toEqual([baseline, baseline]);
    expect(baseline.total).toBe(64);
    expect(baseline.jobs).toHaveLength(50);

    releaseLocalCronRunReceiptOwnership(receipts[0]!);
    let settled = false;
    pending = onTimer(scheduler).finally(() => {
      settled = true;
    });
    await posted.promise;
    const { port1, port2 } = new MessageChannel();
    try {
      const heartbeat = once(port1, "message");
      port2.postMessage("heartbeat");
      expect(await heartbeat).toEqual(["heartbeat"]);
    } finally {
      port1.close();
      port2.close();
    }
    expect(settled).toBe(false);
    cron.stop();
    await writer.stop();
    await pending;
    expect(inspectActiveCronRunReceipt({ storePath, jobId: jobs[0]!.id })).toBeUndefined();
    const repaired = (await loadCronStore(storePath)).jobs[0];
    expect(repaired?.state.runningAtMs).toBeUndefined();
    expect(repaired?.state).toMatchObject({
      lastRunStatus: "error",
      lastError: "cron: job interrupted by gateway restart",
    });
    expect(onEvent.mock.calls.filter(([event]) => event.action === "finished")).toEqual([
      [expect.objectContaining({ jobId: jobs[0]!.id, status: "error" })],
    ]);
    expect(runner).not.toHaveBeenCalled();
    expect(scheduler.activeTimerTicks).toBe(0);
  } finally {
    watchdog?.removeEventListener("abort", releaseStuckWriter);
    cron.stop();
    await writer?.stop();
    await pending;
    observe.mockRestore();
    for (const receipt of receipts) {
      releaseLocalCronRunReceiptOwnership(receipt);
    }
    openOpenClawStateDatabase().db.exec("DROP TABLE IF EXISTS writes");
  }
});

async function seedInterruptedBatch() {
  const { storePath } = await makeStorePath();
  const nowMs = Date.now();
  const jobs = ["first", "second"].map((id, index) => {
    const job = makeCronRecoveryJob(id, nowMs - 1_000 + index);
    job.enabled = false;
    return job;
  });
  const onEvent = vi.fn();
  const runner = vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    defaultAgentId: "alpha",
    isAgentAvailable: () => true,
    nowMs: () => nowMs,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: runner,
    runCommandJob: runner,
    onEvent,
  });
  await writeCronStoreSnapshot({ storePath, jobs });
  for (const job of jobs) {
    const startedAtMs = job.state.runningAtMs!;
    const prepared = prepareCronRunReceiptClaim({
      observed: undefined,
      storePath,
      job,
      agentId: "alpha",
      startedAtMs,
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabaseForTest({
        database: db,
        prepared,
        resolveAgentId: () => "alpha",
      }),
    );
    job.state.runningReceiptId = receipt.receiptId;
    releaseLocalCronRunReceiptOwnership(receipt);
  }
  await writeCronStoreSnapshot({ storePath, jobs });
  const history = (jobId: string) =>
    readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId }).entries;
  return { storePath, jobs, state, onEvent, runner, history };
}

it.each([
  ["timer", onTimer],
  ["startup", start],
] as const)(
  "publishes committed interruptions before retiring %s held at its reload",
  async (source, recover) => {
    const { storePath, jobs, state, onEvent, runner, history } = await seedInterruptedBatch();
    const entered = createDeferred();
    const release = createDeferred();
    const load = cronStore.loadCronJobsStoreWithConfigJobs;
    let loads = 0;
    const delayed = vi
      .spyOn(cronStore, "loadCronJobsStoreWithConfigJobs")
      .mockImplementation(async (path) => {
        const result = await load(path);
        if (path === storePath && ++loads === 2) {
          entered.resolve();
          await release.promise;
        }
        return result;
      });
    const admissions = observeCronTimerAdmissions(state);
    const tick = recover(state);
    let restarted: Promise<void> | undefined;
    try {
      await entered.promise;
      if (source === "timer") {
        await admissions.expectActive();
      }
      const committed = await loadCronStore(storePath);
      for (const job of jobs) {
        const stored = committed.jobs.find((entry) => entry.id === job.id);
        expect(stored?.state).toMatchObject({ lastRunStatus: "error" });
        expect(stored?.state.runningAtMs).toBeUndefined();
        expect(stored?.state.runningReceiptId).toBeUndefined();
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
        expect(history(job.id)).toEqual([]);
      }
      expect(
        onEvent.mock.calls.map(([event]) => event).filter((event) => event.action === "finished"),
      ).toEqual([]);

      stop(state);
      restarted = start(state);
      expect(state.stopped).toBe(false);
      release.resolve();
      await tick;
      await restarted;

      const finished = onEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.action === "finished");
      expect(finished).toMatchObject(
        jobs.map((job) => ({
          jobId: job.id,
          status: "error",
          error: "cron: job interrupted by gateway restart",
          runAtMs: job.state.runningAtMs,
        })),
      );
      for (const job of jobs) {
        const entries = history(job.id);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          jobId: job.id,
          status: "error",
          error: "cron: job interrupted by gateway restart",
          runAtMs: job.state.runningAtMs,
        });
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      }
      expect(runner).not.toHaveBeenCalled();
      expect(state.activeTimerTicks).toBe(0);
      expect(state.runAdmission.active).toBe(0);
      expect(state.runAdmission.waiters).toEqual([]);
      expect(state.queuedRunReservationsByJobId.size).toBe(0);

      await admissions.expectReleased(source === "timer" ? 1 : 0);
    } finally {
      release.resolve();
      await Promise.allSettled([tick, ...(restarted ? [restarted] : [])]);
      delayed.mockRestore();
      stop(state);
    }
  },
);

it("retains a committed repair after reply loss without replaying it on the next tick", async () => {
  const { storePath } = await makeStorePath();
  const nowMs = Date.now();
  const jobs = ["first", "second"].map((id, index) => {
    const job = makeCronRecoveryJob(id, nowMs - 1_000 + index);
    job.enabled = false;
    job.delivery = { mode: "announce", channel: "last" };
    job.failureAlert = { after: 1, cooldownMs: 0 };
    return job;
  });
  const enqueueSystemEvent = vi.fn();
  const onEvent = vi.fn<(event: CronEvent) => void>();
  const runner = vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    defaultAgentId: "alpha",
    isAgentAvailable: () => true,
    nowMs: () => nowMs,
    log: logger,
    enqueueSystemEvent,
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: runner,
    runCommandJob: runner,
    onEvent,
  });
  await writeCronStoreSnapshot({ storePath, jobs });
  for (const job of jobs) {
    const receipt = claimCronRecoveryReceipt(storePath, job, job.state.runningAtMs!);
    job.state.runningReceiptId = receipt.receiptId;
    releaseLocalCronRunReceiptOwnership(receipt);
  }
  await writeCronStoreSnapshot({ storePath, jobs });
  const history = (jobId: string) =>
    readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId }).entries;
  const finishedIds = () =>
    onEvent.mock.calls.flatMap(([event]) => (event.action === "finished" ? [event.jobId] : []));
  const notificationKeys = () =>
    enqueueSystemEvent.mock.calls.map(([, options]) => options.contextKey);

  const admissions = observeCronTimerAdmissions(state);
  const reply = loseFirstCronMutationReply();
  const pending: Promise<unknown>[] = [];
  onTestFinished(async () => {
    await reply.close();
    stop(state);
    await Promise.allSettled(pending);
    await state.op;
  });

  const firstTick = onTimer(state);
  pending.push(firstTick);
  await expect(firstTick).rejects.toBeInstanceOf(Error);
  await admissions.expectReleased(1);
  await reply.waitForExit();
  expect(reply.wasDropped()).toBe(true);
  expect(reply.attempts).toEqual(["first"]);
  expect(finishedIds()).toEqual([]);
  expect(notificationKeys()).toEqual([]);
  const afterLoss = await loadCronStore(storePath);
  expect(afterLoss.jobs[0]?.state).toMatchObject({ lastRunStatus: "error", consecutiveErrors: 1 });
  expect(afterLoss.jobs[0]?.state.runningAtMs).toBeUndefined();
  expect(afterLoss.jobs[1]?.state.runningAtMs).toBe(jobs[1]!.state.runningAtMs);
  expect(inspectActiveCronRunReceipt({ storePath, jobId: "first" })).toBeUndefined();
  expect(inspectActiveCronRunReceipt({ storePath, jobId: "second" })?.receiptId).toBe(
    jobs[1]!.state.runningReceiptId,
  );
  // Reply loss can drop host history and notifications, but not the committed repair.
  expect(history("first")).toEqual([]);
  expect(history("second")).toEqual([]);

  const secondTick = onTimer(state);
  pending.push(secondTick);
  await secondTick;
  expect(reply.attempts).toEqual(["first", "second"]);
  expect(finishedIds()).toEqual(["second"]);
  expect(notificationKeys()).toEqual(["cron:second:failure-alert"]);
  for (const job of jobs) {
    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
  }
  expect(history("first")).toEqual([]);
  expect(history("second")).toEqual([
    expect.objectContaining({ jobId: "second", status: "error" }),
  ]);
  expect((await loadCronStore(storePath)).jobs.map((job) => job.state.consecutiveErrors)).toEqual([
    1, 1,
  ]);
  expect(runner).not.toHaveBeenCalled();
  expect(state.activeTimerTicks).toBe(0);

  await admissions.expectReleased(2);
});

it("reloads committed schedule maintenance after reply loss without repeating its effects", async () => {
  const { storePath } = await makeStorePath();
  const nowMs = Date.now();
  const job = makeCronRecoveryJob("invalid-schedule", nowMs);
  job.schedule = { kind: "cron", expr: "invalid" };
  job.state = { scheduleErrorCount: 2 };
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  const enqueueSystemEvent = vi.fn();
  const state = makeCronRecoveryState(logger, storePath, nowMs, { enqueueSystemEvent });
  const reply = loseFirstCronMutationReply("cron.scheduleUnowned");
  onTestFinished(async () => {
    await reply.close();
    stop(state);
    await state.op;
  });
  await expect(ensureLoadedForRead(state)).rejects.toBeInstanceOf(Error);
  await reply.waitForExit();
  expect(reply.wasDropped()).toBe(true);
  const persisted = (await loadCronStore(storePath)).jobs[0];
  expect(persisted).toMatchObject({ enabled: false, state: { scheduleErrorCount: 3 } });
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
  await ensureLoadedForRead(state);
  expect(state.store?.jobs[0]).toEqual(persisted);
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
  expect(reply.attempts).toHaveLength(2);
});
