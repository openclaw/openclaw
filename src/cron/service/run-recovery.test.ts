import { serialize } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore, saveCronJobsStore } from "../store.js";
import {
  finishCronRunReceipt,
  finishCronRunReceiptInDatabase,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import {
  inspectActiveCronRunReceipt,
  makeCronRecoveryJob as makeJob,
} from "../store/run-receipt-store.test-support.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronJob } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import {
  claimCronRecoveryReceipt as claimReceipt,
  makeCronRecoveryState as makeState,
  observeCronRecoveryForTest,
  recoverCronRunForTest,
} from "./run-recovery.test-support.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import {
  tryCreateCronTaskRunHandle,
  tryFinishCronTaskRun,
  tryFinishCronTaskRunWithoutHistory,
} from "./task-runs.js";
import { onTimer } from "./timer.test-support.js";

function tryCreateCronTaskRun(
  params: Parameters<typeof tryCreateCronTaskRunHandle>[0],
): string | undefined {
  return tryCreateCronTaskRunHandle(params)?.runId;
}

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-run-recovery-" });

async function commitCompletedJob(params: {
  storePath: string;
  jobs: CronJob[];
  receipt: CronRunReceiptHandle;
  finishedAtMs: number;
}) {
  await saveCronJobsStore(
    params.storePath,
    { version: 1, jobs: params.jobs },
    {
      transactionHooks: {
        afterWrite: (database) => {
          finishCronRunReceiptInDatabase({
            database,
            handle: params.receipt,
            status: "ok",
            finishedAtMs: params.finishedAtMs,
          });
        },
      },
    },
  );
  releaseLocalCronRunReceiptOwnership(params.receipt);
}

describe("atomic cron run recovery", () => {
  it.each(["startup", "timer"] as const)(
    "retires a delayed %s recovery proposal across stop and restart",
    async (source) => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now();
      const job = makeJob(`retired-${source}-proposal`, startedAtMs);
      job.enabled = false;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const receipt = claimReceipt(storePath, job, startedAtMs);
      job.state.runningReceiptId = receipt.receiptId;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      releaseLocalCronRunReceiptOwnership(receipt);
      const before = await loadCronStore(storePath);
      const onEvent = vi.fn();
      const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
      const reaperDiscovery = vi.fn(() => []);
      const state = createCronServiceState({
        ...makeState(logger, storePath, startedAtMs + 1).deps,
        onEvent,
        runCommandJob,
        resolveSessionStoreAgentIds: reaperDiscovery,
        resolveSessionStorePath: () => `${storePath}.sessions`,
      });
      const barriers = [
        { entered: createDeferred(), release: createDeferred() },
        { entered: createDeferred(), release: createDeferred() },
      ];
      let proposalCount = 0;
      const execute = stateRead.executeExistingOpenClawStateRead;
      const delayed = vi
        .spyOn(stateRead, "executeExistingOpenClawStateRead")
        .mockImplementation(async (context, command) => {
          const result = await execute(context, command);
          if (command.type === "cron.observeRunRecovery") {
            const barrier = barriers[proposalCount++];
            if (barrier) {
              barrier.entered.resolve();
              await barrier.release.promise;
            }
          }
          return result;
        });
      const rootWorkBefore = getActiveGatewayRootWorkCount();
      const retired = source === "startup" ? start(state) : onTimer(state);
      let restarted: Promise<void> | undefined;
      try {
        await barriers[0]!.entered.promise;
        stop(state);
        restarted = start(state);
        expect(state.stopped).toBe(false);
        barriers[0]!.release.resolve();
        await retired;

        // The replacement is also held, so only the retired operation could repair these rows.
        expect(await loadCronStore(storePath)).toEqual(before);
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toEqual(receipt);
        expect(onEvent).not.toHaveBeenCalled();
        expect(runCommandJob).not.toHaveBeenCalled();
        expect(reaperDiscovery).not.toHaveBeenCalled();
        expect(state.activeTimerTicks).toBe(0);
        expect(state.queuedRunReservationsByJobId.size).toBe(0);
        expect(getActiveGatewayRootWorkCount()).toBe(rootWorkBefore);

        await barriers[1]!.entered.promise;
        barriers[1]!.release.resolve();
        await restarted;
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
        expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
          lastRunStatus: "error",
          lastError: "cron: job interrupted by gateway restart",
        });
        expect(onEvent.mock.calls.filter(([event]) => event.action === "finished")).toHaveLength(1);
        expect(runCommandJob).not.toHaveBeenCalled();
      } finally {
        for (const barrier of barriers) {
          barrier.release.resolve();
        }
        await Promise.allSettled([retired, ...(restarted ? [restarted] : [])]);
        delayed.mockRestore();
        stop(state);
      }
    },
  );

  it("repairs a large unowned store without database work on the host", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.parse("2026-08-30T12:00:00.000Z");
    const jobs = Array.from({ length: 100 }, (_, index) => {
      const entry = makeJob(`batch-repair-${index}`, nowMs);
      entry.state = {};
      return entry;
    });
    await writeCronStoreSnapshot({ storePath, jobs });
    const owned = jobs[0]!;
    const receipt = claimReceipt(storePath, owned, nowMs);
    const database = openOpenClawStateDatabase().db;
    const ownedRowBefore = database
      .prepare("SELECT * FROM cron_jobs WHERE store_key = ? AND job_id = ?")
      .get(receipt.storeKey, owned.id);
    const receiptBefore = database
      .prepare("SELECT * FROM cron_run_receipts WHERE receipt_id = ?")
      .get(receipt.receiptId);
    const statements = observeHostDataSql();

    try {
      const result = await recomputeUnownedCronSchedules(makeState(logger, storePath, nowMs));
      expect(result.jobs).toHaveLength(99);
      const hostCalls = statements.calls.map((call) => call.mock.calls.length);
      statements.restore();
      expect(hostCalls).toEqual(hostCalls.map(() => 0));
      expect(
        database
          .prepare("SELECT * FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(receipt.storeKey, owned.id),
      ).toEqual(ownedRowBefore);
      expect(
        database
          .prepare("SELECT * FROM cron_run_receipts WHERE receipt_id = ?")
          .get(receipt.receiptId),
      ).toEqual(receiptBefore);
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(
        jobs.map((job) => job.id),
      );
    } finally {
      statements.restore();
      finishCronRunReceipt({ handle: receipt, status: "ok", finishedAtMs: nowMs + 1 });
    }
  });

  it("rolls back receipt retirement when the pending recovery slot cannot commit", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now();
    const job = makeJob("recovery-rollback", startedAtMs);
    job.schedule = { kind: "at", at: new Date(startedAtMs).toISOString() };
    job.deleteAfterRun = true;
    job.delivery = { mode: "none" };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const receipt = claimReceipt(storePath, job, startedAtMs);
    releaseLocalCronRunReceiptOwnership(receipt);
    const state = makeState(logger, storePath, startedAtMs);
    const proposal = await observeCronRecoveryForTest(state, job.id, undefined, startedAtMs);
    const database = openOpenClawStateDatabase().db;
    const read = stateRead.executeExistingOpenClawStateRead;
    let installed = false;
    const injectFailure = vi
      .spyOn(stateRead, "executeExistingOpenClawStateRead")
      .mockImplementation(async (...args) => {
        const observed = await read(...args);
        if (args[1].type === "cron.observeRunRecovery" && !installed) {
          // Install after read admission, so the fault reaches the real repair transaction.
          database.exec(`
            CREATE TRIGGER reject_pending_recovery
            BEFORE UPDATE ON cron_jobs
            WHEN NEW.job_id = 'recovery-rollback'
              AND json_extract(NEW.state_json, '$.startupCatchupAtMs') IS NOT NULL
            BEGIN
              SELECT RAISE(ABORT, 'pending recovery unavailable');
            END;
          `);
          installed = true;
        }
        return observed;
      });
    try {
      await expect(recoverCronRunForTest(state, proposal, "startup")).rejects.toThrow(
        "pending recovery unavailable",
      );
    } finally {
      injectFailure.mockRestore();
      database.exec("DROP TRIGGER IF EXISTS reject_pending_recovery");
    }
    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })?.receiptId).toBe(
      receipt.receiptId,
    );
    const persisted = (await loadCronStore(storePath)).jobs[0];
    expect(persisted?.state.runningAtMs).toBe(startedAtMs);
    expect(persisted?.state.startupCatchupAtMs).toBeUndefined();
    expect(persisted?.state.lastRunStatus).toBeUndefined();
    expect(await recoverCronRunForTest(state, proposal, "startup")).toMatchObject({
      kind: "repaired",
    });
    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
    const pending = (await loadCronStore(storePath)).jobs[0];
    expect(pending?.state).toMatchObject({
      nextRunAtMs: startedAtMs,
      startupCatchupAtMs: startedAtMs,
      consecutiveErrors: 1,
    });
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
    for (let restart = 0; restart < 3; restart += 1) {
      const next = createCronServiceState({ ...state.deps, runCommandJob });
      try {
        await start(next);
        expect(runCommandJob).toHaveBeenCalledOnce();
        expect((await loadCronStore(storePath)).jobs).toHaveLength(0);
      } finally {
        stop(next);
      }
    }
  });

  it("preserves newer one-shot lifecycle state when startup replays finalized task history", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-31T12:00:00.000Z");
    const endedAtMs = startedAtMs + 2_000;
    const persistedRetryAtMs = endedAtMs + 120_000;
    const historyRetryAtMs = endedAtMs + 30_000;
    const oneShot = (id: string, enabled: boolean, nextRunAtMs?: number) => {
      const job = makeJob(id, startedAtMs);
      job.enabled = enabled;
      job.schedule = { kind: "at", at: new Date(startedAtMs).toISOString() };
      job.state.nextRunAtMs = nextRunAtMs;
      return job;
    };
    const jobs = [
      oneShot("persisted-retry-without-history", true, persistedRetryAtMs),
      oneShot("persisted-retry", true, persistedRetryAtMs),
      oneShot("history-retry", true, startedAtMs),
      oneShot("persisted-disable", false),
      makeJob("recurring-history", startedAtMs),
    ];
    const historyNextRunAtMs = new Map<string, number | undefined>([
      ["persisted-retry-without-history", undefined],
      ["persisted-retry", historyRetryAtMs],
      ["history-retry", historyRetryAtMs],
      ["persisted-disable", historyRetryAtMs],
      ["recurring-history", historyRetryAtMs],
    ]);
    const executionState = makeState(logger, storePath, endedAtMs);

    for (const job of jobs) {
      const taskRunId = tryCreateCronTaskRun({
        state: executionState,
        job,
        startedAt: startedAtMs,
      });
      expect(taskRunId).toBeDefined();
      tryFinishCronTaskRun(executionState, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          error: 'Session "agent:alpha:cron:recovery" changed while starting work. Retry.',
          runAtMs: startedAtMs,
          durationMs: endedAtMs - startedAtMs,
          nextRunAtMs: historyNextRunAtMs.get(job.id),
        },
      });
    }
    // Production finalization writes task history before its newer job row.
    await writeCronStoreSnapshot({ storePath, jobs });

    const recovered = makeState(logger, storePath, endedAtMs);
    try {
      await start(recovered);
      const persisted = new Map(
        (await loadCronStore(storePath)).jobs.map((job) => [job.id, job] as const),
      );
      expect(persisted.get("persisted-retry-without-history")).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: persistedRetryAtMs },
      });
      expect(persisted.get("persisted-retry")).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: persistedRetryAtMs },
      });
      expect(persisted.get("history-retry")).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: historyRetryAtMs },
      });
      expect(persisted.get("persisted-disable")?.enabled).toBe(false);
      expect(persisted.get("persisted-disable")?.state.nextRunAtMs).toBeUndefined();
      expect(persisted.get("recurring-history")).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: historyRetryAtMs },
      });
    } finally {
      stop(recovered);
    }
  });

  it.each([
    { terminal: undefined, deleteAfterRun: false },
    { terminal: undefined, deleteAfterRun: true },
    { terminal: "ok", deleteAfterRun: false },
    { terminal: "ok", deleteAfterRun: true },
    { terminal: "error", deleteAfterRun: false },
    { terminal: "error", deleteAfterRun: true },
    { terminal: "skipped", deleteAfterRun: false },
    { terminal: "skipped", deleteAfterRun: true },
    { terminal: undefined, deleteAfterRun: true, result: "error" },
  ] as const)(
    "recovers only a nonterminal one-shot across three restarts (terminal=$terminal, deleteAfterRun=$deleteAfterRun, result=$result)",
    async (testCase) => {
      const { terminal, deleteAfterRun } = testCase;
      const recoveredStatus = testCase.result ?? "ok";
      const finalStatus = terminal ?? recoveredStatus;
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now() - (deleteAfterRun ? 365 * 24 * 60 * 60_000 : 0);
      const job = makeJob("restart-one-shot", startedAtMs);
      job.schedule = { kind: "at", at: new Date(startedAtMs).toISOString() };
      job.deleteAfterRun = deleteAfterRun;
      job.delivery = { mode: "none" };
      // A recovered execution can itself die after writing its terminal task.
      job.state.startupCatchupAtMs = startedAtMs;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const original = makeState(logger, storePath, startedAtMs);
      const receipt = claimReceipt(storePath, job, startedAtMs);
      const taskRunId = tryCreateCronTaskRun({
        state: original,
        job,
        startedAt: startedAtMs,
        runReceipt: receipt,
      });
      expect(taskRunId).toBeDefined();
      if (terminal) {
        tryFinishCronTaskRun(original, {
          taskRunId,
          job,
          event: {
            jobId: job.id,
            action: "finished",
            job,
            status: terminal,
            completionStatus: terminal === "ok" ? "succeeded" : "failed",
            deliveryStatus: "not-requested",
            error: terminal === "error" ? "command failed" : undefined,
            runAtMs: startedAtMs,
            durationMs: 1,
          },
        });
      }
      // Lose the process after admission (and optional terminal ledger write),
      // before the job row and receipt have settled.
      releaseLocalCronRunReceiptOwnership(receipt);
      const runCommandJob = vi.fn<NonNullable<CronServiceDeps["runCommandJob"]>>(async () => ({
        status: recoveredStatus,
        summary: "recovered",
        error: recoveredStatus === "error" ? "command failed" : undefined,
      }));
      const onEvent = vi.fn();
      for (let restart = 0; restart < 3; restart += 1) {
        const state = createCronServiceState({
          ...makeState(logger, storePath, Date.now()).deps,
          runCommandJob,
          onEvent,
        });
        try {
          await start(state);
          expect(runCommandJob).toHaveBeenCalledTimes(terminal ? 0 : 1);
          const persisted = (await loadCronStore(storePath)).jobs.find(
            (entry) => entry.id === job.id,
          );
          if (deleteAfterRun && finalStatus === "ok") {
            expect(persisted).toBeUndefined();
          } else {
            expect(persisted).toMatchObject({
              enabled: false,
              state: { lastRunStatus: finalStatus },
            });
            expect(persisted?.state.runningAtMs).toBeUndefined();
            expect(persisted?.state.nextRunAtMs).toBeUndefined();
            expect(persisted?.state.startupCatchupAtMs).toBeUndefined();
          }
          expect(
            onEvent.mock.calls
              .filter(([event]) => event.action === "finished")
              .map(([event]) => event.status),
          ).toEqual(terminal ? [] : ["error", recoveredStatus]);
        } finally {
          stop(state);
        }
      }
    },
  );

  it.each(["repair", "agent-deferral", "overflow-deferral"] as const)(
    "keeps one-shot recovery durable across restart after %s",
    async (phase) => {
      const { storePath } = await makeStorePath();
      const nowMs = Date.now();
      const startedAtMs = nowMs - 365 * 24 * 60 * 60_000;
      const job = makeJob("pending-one-shot", startedAtMs);
      job.schedule = { kind: "at", at: new Date(startedAtMs).toISOString() };
      job.deleteAfterRun = true;
      job.delivery = { mode: "none" };
      if (phase === "agent-deferral") {
        job.payload = { kind: "agentTurn", message: "recover pending work" };
      }
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const receipt = claimReceipt(storePath, job, startedAtMs);
      const original = makeState(logger, storePath, nowMs);
      tryCreateCronTaskRun({ state: original, job, startedAt: startedAtMs, runReceipt: receipt });
      releaseLocalCronRunReceiptOwnership(receipt);
      const finished = createDeferred();
      const runJob = vi.fn(async () => ({ status: "ok" as const }));
      const freshState = () =>
        createCronServiceState({
          ...original.deps,
          nowMs: Date.now,
          onEvent(event) {
            if (event.action === "finished" && event.status === "ok") {
              finished.resolve();
            }
          },
          runCommandJob: runJob,
          runIsolatedAgentJob: runJob,
          ...(phase === "overflow-deferral" ? { maxMissedJobsPerRestart: 0 } : {}),
        });
      const first = freshState();
      try {
        if (phase === "repair") {
          const proposal = await observeCronRecoveryForTest(first, job.id, undefined, startedAtMs);
          expect(await recoverCronRunForTest(first, proposal, "startup")).toMatchObject({
            kind: "repaired",
          });
          expect(await recoverCronRunForTest(first, proposal, "startup")).toMatchObject({
            kind: "superseded",
          });
          await recomputeUnownedCronSchedules(first, { recomputeExpired: true });
        } else {
          await start(first);
        }
        expect(runJob).not.toHaveBeenCalled();
        const pending = (await loadCronStore(storePath)).jobs[0];
        expect(pending).toMatchObject({ enabled: true, state: { consecutiveErrors: 1 } });
        const dueAt =
          phase === "repair" ? startedAtMs : nowMs + (phase === "agent-deferral" ? 120_000 : 5_000);
        expect(pending?.state.nextRunAtMs).toBe(dueAt);
        expect(pending?.state.startupCatchupAtMs).toBe(dueAt);
        expect(pending?.state.runningAtMs).toBeUndefined();
      } finally {
        stop(first);
      }
      if (phase !== "repair") {
        for (let restart = 0; restart < 3; restart += 1) {
          await vi.advanceTimersByTimeAsync(1);
          const pendingState = freshState();
          try {
            await start(pendingState);
            const pending = (await loadCronStore(storePath)).jobs[0];
            const dueAt = nowMs + (phase === "agent-deferral" ? 120_000 : 5_000);
            expect(pending).toMatchObject({
              enabled: true,
              state: { nextRunAtMs: dueAt, startupCatchupAtMs: dueAt, consecutiveErrors: 1 },
            });
            expect(runJob).not.toHaveBeenCalled();
          } finally {
            stop(pendingState);
          }
        }
      }
      const second = freshState();
      try {
        await start(second);
        if (phase !== "repair") {
          expect(runJob).not.toHaveBeenCalled();
          const delay = nowMs + (phase === "agent-deferral" ? 120_000 : 5_000) - Date.now();
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(runJob).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          await finished.promise;
          await second.op;
        }
        expect(runJob).toHaveBeenCalledOnce();
        expect((await loadCronStore(storePath)).jobs).toHaveLength(0);
      } finally {
        stop(second);
      }
      const third = freshState();
      try {
        await start(third);
        expect(runJob).toHaveBeenCalledOnce();
      } finally {
        stop(third);
      }
    },
  );

  it("retires a stale settling receipt after its marker is already gone", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:15:00.000Z");
    const job = makeJob("markerless-settling-owner-death", startedAtMs);
    delete job.state.runningAtMs;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(logger, storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(await recoverCronRunForTest(state, { jobId: job.id, receipt })).toMatchObject({
      kind: "repaired",
    });
    const receiptRow = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId),
    ) as { status: string };
    expect(receiptRow.status).toBe("interrupted");
  });

  it("repairs a matching marker after its observed receipt terminalizes", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:30:00.000Z");
    const job = makeJob("terminalized-before-recovery", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(logger, storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const proposal = await observeCronRecoveryForTest(state, job.id, undefined, startedAtMs);
    runOpenClawStateWriteTransaction(({ db }) =>
      finishCronRunReceiptInDatabase({
        database: db,
        handle: receipt,
        status: "ok",
        finishedAtMs: startedAtMs + 1,
      }),
    );

    expect(await recoverCronRunForTest(state, proposal)).toMatchObject({ kind: "repaired" });
    const persisted = (await loadCronStore(storePath)).jobs[0]?.state;
    expect(persisted?.runningAtMs).toBeUndefined();
    expect(persisted?.lastRunStatus).toBe("error");
    releaseLocalCronRunReceiptOwnership(receipt);
  });

  it.each([false, true])(
    "queues a threshold-crossing interrupted-run alert after persistence (large facts=%s)",
    async (largeFacts) => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.parse("2026-08-13T10:35:00.000Z");
      const nowMs = startedAtMs + 30_000;
      const job = makeJob("interrupted-threshold-alert", startedAtMs);
      if (largeFacts) {
        job.name = "n".repeat(17 * 1024 * 1024);
      }
      job.delivery = { mode: "announce", channel: "last" };
      job.failureAlert = { after: 2, cooldownMs: 60_000 };
      job.state.consecutiveErrors = 1;
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const sendCronFailureAlert = vi.fn(async () => undefined);
      const state = makeState(logger, storePath, nowMs, { sendCronFailureAlert });

      const result = await recoverCronRunForTest(state, {
        jobId: job.id,
        runningAtMs: startedAtMs,
      });

      expect(result).toMatchObject({ kind: "repaired" });
      if (result.kind !== "repaired") {
        throw new Error("expected repaired interrupted run");
      }
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      expect(result.notifications).toHaveLength(1);
      if (largeFacts) {
        expect(serialize(result).byteLength).toBeGreaterThan(SQLITE_WORKER_MAX_MESSAGE_BYTES);
      }
      expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
        consecutiveErrors: 2,
        lastFailureAlertAtMs: nowMs,
        lastFailureNotificationDeliveryStatus: "unknown",
      });

      runPostPersistCronNotifications(state, result.notifications);
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(sendCronFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          runAtMs: startedAtMs,
          payload: expect.objectContaining({
            text: expect.stringContaining("failed 2 times"),
          }),
        }),
      );
    },
  );

  it("keeps interrupted-run alerts disabled by failureAlert false", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:36:00.000Z");
    const job = makeJob("interrupted-alert-disabled", startedAtMs);
    job.delivery = { mode: "announce", channel: "last" };
    job.failureAlert = false;
    job.state.consecutiveErrors = 1;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = makeState(logger, storePath, startedAtMs + 30_000, { sendCronFailureAlert });

    const result = await recoverCronRunForTest(state, {
      jobId: job.id,
      runningAtMs: startedAtMs,
    });

    expect(result).toMatchObject({ kind: "repaired", notifications: [] });
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
      consecutiveErrors: 2,
      lastFailureNotificationDeliveryStatus: "not-requested",
    });
  });

  it("keeps only auto-disable notification on the tenth interrupted failure", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:37:00.000Z");
    const nowMs = startedAtMs + 30_000;
    const job = makeJob("interrupted-auto-disable", startedAtMs);
    job.delivery = { mode: "announce", channel: "last" };
    job.failureAlert = { after: 10, cooldownMs: 0 };
    job.state.consecutiveErrors = 9;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const enqueueSystemEvent = vi.fn();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = makeState(logger, storePath, nowMs, { enqueueSystemEvent, sendCronFailureAlert });

    const result = await recoverCronRunForTest(state, {
      jobId: job.id,
      runningAtMs: startedAtMs,
    });

    expect(result).toMatchObject({ kind: "repaired" });
    if (result.kind !== "repaired") {
      throw new Error("expected repaired interrupted run");
    }
    expect(result.notifications).toHaveLength(1);
    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      enabled: false,
      state: {
        consecutiveErrors: 10,
        lastFailureNotificationDeliveryStatus: "not-requested",
        autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 },
      },
    });

    runPostPersistCronNotifications(state, result.notifications);
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
  });

  it("restores a finalized quiet trigger with a skipped receipt", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:45:00.000Z");
    const job = makeJob("quiet-trigger-recovery", startedAtMs);
    job.trigger = { script: "return false" };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(logger, storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const proposal = await observeCronRecoveryForTest(state, job.id, undefined, startedAtMs);
    const taskRunId = tryCreateCronTaskRun({
      state,
      job,
      startedAt: startedAtMs,
      runReceipt: receipt,
    });
    tryFinishCronTaskRunWithoutHistory(state, {
      taskRunId,
      status: "ok",
      endedAt: startedAtMs + 1,
      triggerEval: { fired: false, stateChanged: true, state: { ready: false } },
    });
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(await recoverCronRunForTest(state, proposal)).toMatchObject({ kind: "repaired" });
    const persisted = (await loadCronStore(storePath)).jobs[0]?.state;
    expect(persisted?.runningAtMs).toBeUndefined();
    expect(persisted?.lastRunAtMs).toBeUndefined();
    expect(persisted?.triggerState).toEqual({ ready: false });
    const receiptRow = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId),
    ) as { status: string };
    expect(receiptRow.status).toBe("skipped");
  });

  it("does not restore a prior same-millisecond task for a different receipt", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:50:00.000Z");
    const job = makeJob("same-millisecond-task-recovery", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(logger, storePath, startedAtMs + 30_000);
    const priorReceipt = claimReceipt(storePath, job, startedAtMs);
    const priorTaskRunId = tryCreateCronTaskRun({
      state,
      job,
      startedAt: startedAtMs,
      runReceipt: priorReceipt,
    });
    tryFinishCronTaskRun(state, {
      taskRunId: priorTaskRunId,
      job,
      event: {
        jobId: job.id,
        action: "finished",
        job,
        status: "ok",
        summary: "prior receipt completed",
        runAtMs: startedAtMs,
        durationMs: 1,
      },
    });
    finishCronRunReceipt({
      handle: priorReceipt,
      status: "ok",
      finishedAtMs: startedAtMs + 1,
    });
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const proposal = await observeCronRecoveryForTest(state, job.id, undefined, startedAtMs);
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(await recoverCronRunForTest(state, proposal)).toMatchObject({ kind: "repaired" });
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
      lastRunStatus: "error",
      lastError: expect.stringContaining("interrupted by gateway restart"),
    });
  });

  it("fails closed for a legacy caller-ID task without exact receipt identity", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T10:55:00.000Z");
    const job = makeJob("legacy-manual-task-recovery", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(logger, storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const taskRunId = tryCreateCronTaskRun({
      state,
      job,
      startedAt: startedAtMs,
      publicRunId: "manual:legacy-manual-task-recovery:1",
    });
    tryFinishCronTaskRun(state, {
      taskRunId,
      job,
      event: {
        jobId: job.id,
        action: "finished",
        job,
        status: "ok",
        runId: "manual:legacy-manual-task-recovery:1",
        runAtMs: startedAtMs,
        durationMs: 1,
      },
    });
    const proposal = await observeCronRecoveryForTest(state, job.id, undefined, startedAtMs);
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(await recoverCronRunForTest(state, proposal)).toMatchObject({ kind: "repaired" });
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
      lastRunStatus: "error",
      lastError: expect.stringContaining("interrupted by gateway restart"),
    });
  });

  it("retires a dead owner receipt after timeout state already finalized", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T11:00:00.000Z");
    const job = makeJob("timeout-settlement-owner-death", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(logger, storePath, startedAtMs + 30_000);
    const receipt = claimReceipt(storePath, job, startedAtMs);
    const proposal = await observeCronRecoveryForTest(state, job.id, undefined, startedAtMs);
    const completed = structuredClone(job);
    delete completed.state.runningAtMs;
    completed.state.lastRunAtMs = startedAtMs;
    completed.state.lastRunStatus = "ok";
    completed.state.lastStatus = "ok";
    await writeCronStoreSnapshot({ storePath, jobs: [completed] });
    releaseLocalCronRunReceiptOwnership(receipt);

    expect(await recoverCronRunForTest(state, proposal)).toMatchObject({ kind: "repaired" });
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
      lastRunAtMs: startedAtMs,
      lastRunStatus: "ok",
    });
    const receiptRow = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId),
    ) as { status: string };
    expect(receiptRow.status).toBe("interrupted");
  });

  it("reports a foreign queued-to-running conversion for lifecycle monitoring", async () => {
    const { storePath } = await makeStorePath();
    const queuedAtMs = Date.parse("2026-08-13T11:30:00.000Z");
    const job = makeJob("queued-to-running-owner", queuedAtMs);
    delete job.state.runningAtMs;
    job.state.queuedAtMs = queuedAtMs;
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(logger, storePath, queuedAtMs + 1);
    const running = structuredClone(job);
    delete running.state.queuedAtMs;
    running.state.runningAtMs = queuedAtMs + 1;
    let receipt: CronRunReceiptHandle | undefined;
    const read = stateRead.executeExistingOpenClawStateRead;
    const convert = vi
      .spyOn(stateRead, "executeExistingOpenClawStateRead")
      .mockImplementation(async (...args) => {
        const observed = await read(...args);
        if (args[1].type === "cron.observeRunRecovery" && !receipt) {
          receipt = claimReceipt(storePath, running, queuedAtMs + 1);
          await writeCronStoreSnapshot({ storePath, jobs: [running] });
        }
        return observed;
      });
    try {
      const result = await recoverCronRunForTest(state, { jobId: job.id, queuedAtMs });
      if (!receipt) {
        throw new Error("Expected the successor receipt");
      }
      expect(result).toMatchObject({
        kind: "superseded",
        receipt: { receiptId: receipt.receiptId },
      });
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toEqual(receipt);
      expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(queuedAtMs + 1);
    } finally {
      convert.mockRestore();
    }
    if (!receipt) {
      throw new Error("Expected the successor receipt");
    }
    finishCronRunReceipt({ handle: receipt, status: "interrupted", finishedAtMs: queuedAtMs + 2 });
  });

  it("does not clobber a same-millisecond successor receipt", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T12:00:00.000Z");
    const job = makeJob("same-millisecond-successor", startedAtMs);
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = makeState(logger, storePath, startedAtMs + 30_000);
    const first = claimReceipt(storePath, job, startedAtMs);
    const proposal = await observeCronRecoveryForTest(state, job.id, undefined, startedAtMs);

    finishCronRunReceipt({
      handle: first,
      status: "interrupted",
      finishedAtMs: startedAtMs + 1,
    });
    const successor = claimReceipt(storePath, job, startedAtMs);

    const result = await recoverCronRunForTest(state, proposal);

    expect(result).toMatchObject({
      kind: "superseded",
      receipt: { receiptId: successor.receiptId, startedAtMs },
    });
    expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(startedAtMs);
    const successorRow = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(successor.receiptId),
    ) as { status: string };
    expect(successorRow.status).toBe("running");
    finishCronRunReceipt({
      handle: successor,
      status: "interrupted",
      finishedAtMs: startedAtMs + 2,
    });
  });

  it("keeps each repaired candidate durable across a partial-pass restart", async () => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T13:00:00.000Z");
    const firstJob = makeJob("partial-first", startedAtMs);
    const secondJob = makeJob("partial-second", startedAtMs + 1);
    await writeCronStoreSnapshot({ storePath, jobs: [firstJob, secondJob] });
    const firstReceipt = claimReceipt(storePath, firstJob, startedAtMs);
    const secondReceipt = claimReceipt(storePath, secondJob, startedAtMs + 1);
    releaseLocalCronRunReceiptOwnership(firstReceipt);
    releaseLocalCronRunReceiptOwnership(secondReceipt);
    const firstState = makeState(logger, storePath, startedAtMs + 30_000);
    const firstProposal = await observeCronRecoveryForTest(
      firstState,
      firstJob.id,
      undefined,
      startedAtMs,
    );
    const secondProposal = await observeCronRecoveryForTest(
      firstState,
      secondJob.id,
      undefined,
      startedAtMs + 1,
    );

    expect(await recoverCronRunForTest(firstState, firstProposal)).toMatchObject({
      kind: "repaired",
    });
    const afterFirstRepair = await loadCronStore(storePath);
    const completedSecond = structuredClone(
      afterFirstRepair.jobs.find((entry) => entry.id === secondJob.id)!,
    );
    delete completedSecond.state.runningAtMs;
    completedSecond.state.lastRunAtMs = startedAtMs + 1;
    completedSecond.state.lastRunStatus = "ok";
    completedSecond.state.lastStatus = "ok";
    await commitCompletedJob({
      storePath,
      jobs: afterFirstRepair.jobs.map((entry) =>
        entry.id === completedSecond.id ? completedSecond : entry,
      ),
      receipt: secondReceipt,
      finishedAtMs: startedAtMs + 2_000,
    });

    const restartedState = makeState(logger, storePath, startedAtMs + 31_000);
    expect(await recoverCronRunForTest(restartedState, secondProposal)).toEqual({
      kind: "superseded",
    });
    expect(await recoverCronRunForTest(restartedState, firstProposal)).toEqual({
      kind: "superseded",
    });
    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs.find((entry) => entry.id === firstJob.id)?.state).toMatchObject({
      lastRunStatus: "error",
    });
    const persistedSecond = persisted.jobs.find((entry) => entry.id === secondJob.id)?.state;
    expect(persistedSecond).toMatchObject({ lastRunStatus: "ok" });
    expect(persistedSecond?.runningAtMs).toBeUndefined();
  });
});
