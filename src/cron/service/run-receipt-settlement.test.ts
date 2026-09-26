import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import { CronService, type CronEvent } from "../service.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { loadCronRows, loadedCronStoreFromRows } from "../store/row-codec.js";
import {
  claimCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import { prepareCronRunReceiptWriteSchema } from "../store/run-receipt-write-admission.js";
import { cronStreamScheduleKey } from "../stream-schedule.js";
import type { CronJob } from "../types.js";

const onExitSchedule = { kind: "on-exit", command: "true" } as const;

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-run-receipt-settlement-",
});

function makeTimedJob(id: string, nextRunAtMs: number): CronJob {
  return {
    id,
    agentId: "alpha",
    name: id,
    enabled: true,
    createdAtMs: nextRunAtMs - 1,
    updatedAtMs: nextRunAtMs - 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: nextRunAtMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["true"], timeoutSeconds: 1 },
    state: { nextRunAtMs },
  };
}

function makeService(
  storePath: string,
  runCommandJob: NonNullable<ConstructorParameters<typeof CronService>[0]["runCommandJob"]>,
  onEvent?: ConstructorParameters<typeof CronService>[0]["onEvent"],
) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    runCommandJob,
    onEvent,
  });
}

function latestReceiptStatus(storePath: string, jobId: string): string | undefined {
  const row = openOpenClawStateDatabase()
    .db.prepare(
      "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
    )
    .get(cronStoreKey(storePath), jobId) as { status: string } | undefined;
  return row?.status;
}

describe("cron run receipt settlement", () => {
  it.each(["on-exit", "stream", "empty-stream", "startup", "manual"] as const)(
    "retains the execution owner through %s execution and settlement",
    async (source) => {
      const { storePath } = await makeStorePath();
      const context = new AsyncLocalStorage<"caller" | "scheduler">();
      const observed: Array<string | undefined> = [];
      let schedulerEntries = 0;
      const runPayload = async () => {
        await Promise.resolve();
        observed.push(context.getStore());
        return { status: "ok" as const };
      };
      const service = new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runSchedulerOwned: (run) => {
          schedulerEntries += 1;
          return context.run("scheduler", run);
        },
        onEvent: (event) => {
          if (event.action === "started" || event.action === "finished") {
            observed.push(`${event.action}:${context.getStore()}`);
          }
        },
        runIsolatedAgentJob: runPayload,
        runCommandJob: runPayload,
      });
      try {
        const job = await service.add({
          agentId: "alpha",
          name: `execution context ${source}`,
          enabled: true,
          schedule:
            source === "startup"
              ? { kind: "at", at: new Date(Date.now() - 1_000).toISOString() }
              : source === "on-exit"
                ? onExitSchedule
                : source === "manual"
                  ? { kind: "every", everyMs: 60_000 }
                  : { kind: "stream", command: ["true"] },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload:
            source === "startup"
              ? { kind: "command", argv: ["true"] }
              : { kind: "agentTurn", message: "Read the scheduled result." },
          delivery: { mode: "none" },
        });
        await context.run("caller", async () => {
          const outcome =
            source === "startup"
              ? await service.start()
              : source === "on-exit"
                ? await service.runOnExit(job.id, {
                    schedule: onExitSchedule,
                    signal: new AbortController().signal,
                    commitGuard: () => {},
                    onReserved: () => {},
                  })
                : await service.run(
                    job.id,
                    "force",
                    job.schedule.kind === "stream"
                      ? {
                          streamBatch: source === "empty-stream" ? "" : "one observed batch",
                          streamScheduleKey: cronStreamScheduleKey(job.schedule),
                          streamSourceIdentity: job.state.streamSourceIdentity,
                        }
                      : undefined,
                  );
          expect(outcome).toEqual(source === "startup" ? undefined : { ok: true, ran: true });
          expect(context.getStore()).toBe("caller");
        });
        const owner = source === "manual" ? "caller" : "scheduler";
        expect(observed).toEqual([`started:${owner}`, owner, `finished:${owner}`]);
        expect(schedulerEntries).toBe(source === "manual" ? 0 : 1);
      } finally {
        service.stop();
      }
    },
  );

  it("cancels a settlement wait while another operation holds the store lock", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const job = makeTimedJob("cancel-queued-settlement", Date.now() + 60_000);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const service = makeService(
      storePath,
      vi.fn(async () => ({ status: "ok" as const })),
    );
    const entered = createDeferred();
    const release = createDeferred();
    const update = service.updateWithPrecondition(job.id, { name: "updated" }, async () => {
      entered.resolve();
      await release.promise;
    });
    const controller = new AbortController();
    try {
      await entered.promise;
      let result: boolean | undefined;
      const waiting = service
        .runOnExit(job.id, {
          schedule: onExitSchedule,
          signal: controller.signal,
          commitGuard: () => {},
          onReserved: () => {},
        })
        .then((outcome) => {
          result = outcome.ok && "ran" in outcome && outcome.ran;
        });
      controller.abort();
      await vi.waitFor(() => expect(result).toBe(false));
      await waiting;
    } finally {
      controller.abort();
      release.resolve();
      await update;
      service.stop();
    }
  });

  it.each(["cancel", "stop"] as const)(
    "does not repair a delayed on-exit proposal after %s",
    async (action) => {
      const { storePath } = await makeStorePath();
      const startedAtMs = Date.now() - 1_000;
      const job: CronJob = {
        ...makeTimedJob(`retired-on-exit-proposal-${action}`, startedAtMs),
        schedule: onExitSchedule,
        delivery: { mode: "none" },
        state: { runningAtMs: startedAtMs },
      };
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const prepared = prepareCronRunReceiptClaim({
        storePath,
        job,
        agentId: "alpha",
        startedAtMs,
      });
      const receipt = runOpenClawStateWriteTransaction(({ db }) =>
        claimCronRunReceiptInDatabase({
          database: db,
          receiptSchema: prepareCronRunReceiptWriteSchema(db),
          prepared,
          resolveAgentId: () => "alpha",
        }),
      );
      job.state.runningReceiptId = receipt.receiptId;
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      releaseLocalCronRunReceiptOwnership(receipt);
      const before = await loadCronStore(storePath);
      const entered = createDeferred();
      const release = createDeferred();
      const execute = stateRead.executeExistingOpenClawStateRead;
      const delayed = vi
        .spyOn(stateRead, "executeExistingOpenClawStateRead")
        .mockImplementation(async (context, command) => {
          const result = await execute(context, command);
          if (command.type === "cron.observeRunRecovery") {
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const runner = vi.fn(async () => ({ status: "ok" as const }));
      const onEvent = vi.fn();
      const onReserved = vi.fn();
      const service = makeService(storePath, runner, onEvent);
      const controller = new AbortController();
      const waiting = service.runOnExit(job.id, {
        schedule: onExitSchedule,
        signal: controller.signal,
        commitGuard: () => {},
        onReserved,
      });
      try {
        await entered.promise;
        if (action === "cancel") {
          controller.abort();
        } else {
          service.stop();
        }
        release.resolve();
        await expect(waiting).resolves.toEqual({ ok: true, ran: false, reason: "stopped" });
        // Cancellation can settle the request before its locked continuation retires.
        await service.readJob(job.id);

        expect(await loadCronStore(storePath)).toEqual(before);
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toEqual(receipt);
        expect(
          readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
            .entries,
        ).toEqual([]);
        expect(onEvent).not.toHaveBeenCalled();
        expect(onReserved).not.toHaveBeenCalled();
        expect(runner).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        release.resolve();
        await waiting.catch(() => undefined);
        await service.readJob(job.id);
        delayed.mockRestore();
        service.stop();
      }
    },
  );

  it("records a dead receipt before admitting the next observed exit", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.now() - 1_000;
    const job: CronJob = {
      ...makeTimedJob("on-exit-dead-receipt", startedAtMs),
      schedule: onExitSchedule,
      delivery: { mode: "none" },
      state: { runningAtMs: startedAtMs },
    };
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: "alpha",
      startedAtMs,
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabase({
        database: db,
        receiptSchema: prepareCronRunReceiptWriteSchema(db),
        prepared,
        resolveAgentId: () => "alpha",
      }),
    );
    // Process exit drops the local liveness claim but leaves the durable receipt.
    releaseLocalCronRunReceiptOwnership(receipt);
    const interrupted = {
      jobId: job.id,
      status: "error",
      completionStatus: "failed",
      error: "cron: job interrupted by gateway restart",
      runAtMs: startedAtMs,
    };
    const history = () =>
      readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id }).entries;
    const onEvent = vi.fn<(event: CronEvent) => void>();
    const onReserved = vi.fn(() => {
      expect(history()).toMatchObject([interrupted]);
      expect(
        onEvent.mock.calls.map(([event]) => event).filter((event) => event.action === "finished"),
      ).toMatchObject([interrupted]);
    });
    const runner = vi.fn(async () => {
      expect(onReserved).toHaveBeenCalledOnce();
      return { status: "ok" as const, summary: "successor completed" };
    });
    const service = makeService(storePath, runner, onEvent);
    const controller = new AbortController();
    try {
      await expect(
        service.runOnExit(job.id, {
          schedule: onExitSchedule,
          signal: controller.signal,
          commitGuard: () => {},
          onReserved,
        }),
      ).resolves.toEqual({ ok: true, ran: true });
      expect(runner).toHaveBeenCalledOnce();
      expect(history()).toHaveLength(2);
      expect(history()).toEqual(
        expect.arrayContaining([
          expect.objectContaining(interrupted),
          expect.objectContaining({
            status: "ok",
            completionStatus: "succeeded",
            summary: "successor completed",
          }),
        ]),
      );
      const statuses = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms",
        )
        .all(cronStoreKey(storePath), job.id) as Array<{ status: string }>;
      expect(statuses.map((row) => row.status)).toEqual(["interrupted", "ok"]);
    } finally {
      controller.abort();
      service.stop();
    }
  });

  it.each(["manual", "startup", "manual-finish-retry"] as const)(
    "keeps a timed-out %s runner fenced until its underlying work settles",
    async (trigger) => {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { storePath } = await makeStorePath();
      const now = Date.now();
      const job = makeTimedJob(
        `late-${trigger}-settlement`,
        trigger === "startup" ? now - 1 : now + 60_000,
      );
      await saveCronStore(storePath, { version: 1, jobs: [job] });

      const runnerStarted = createDeferred();
      const releaseRunner = createDeferred<{ status: "ok"; summary: string }>();
      const owner = makeService(storePath, async () => {
        runnerStarted.resolve();
        return await releaseRunner.promise;
      });
      const successorRunner = vi.fn(async () => ({ status: "ok" as const }));
      const successor = makeService(storePath, successorRunner);
      const stoppedObserver = makeService(storePath, successorRunner);
      const settlementAbort = new AbortController();
      const first =
        trigger === "startup" ? owner.start() : owner.run(job.id, "force").then(() => undefined);

      try {
        await runnerStarted.promise;
        // Exercise the execution deadline and cleanup guard without waiting on wall time.
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(20_000);
        await first;
        expect(latestReceiptStatus(storePath, job.id)).toBe("running");
        await successor.update(job.id, { schedule: onExitSchedule, enabled: true });
        let settled = false;
        const onReserved = vi.fn();
        const options = {
          schedule: onExitSchedule,
          signal: settlementAbort.signal,
          commitGuard: () => {},
          onReserved,
        };
        const settlement = successor.runOnExit(job.id, options).then((result) => {
          settled = true;
          return result;
        });
        const cancelled = new AbortController();
        const cancelledWait = successor.runOnExit(job.id, { ...options, signal: cancelled.signal });
        const stoppedWait = stoppedObserver.runOnExit(job.id, options);
        // These reads also prove that a pending receipt wait releases the service lock.
        await Promise.all([successor.readJob(job.id), stoppedObserver.readJob(job.id)]);
        expect(settled).toBe(false);
        cancelled.abort();
        await expect(cancelledWait).resolves.toEqual({ ok: true, ran: false, reason: "stopped" });
        stoppedObserver.stop();
        await expect(stoppedWait).resolves.toEqual({ ok: true, ran: false, reason: "stopped" });
        expect(settled).toBe(false);
        expect(latestReceiptStatus(storePath, job.id)).toBe("running");
        await expect(successor.run(job.id, "force")).resolves.toEqual({
          ok: true,
          ran: false,
          reason: "already-running",
        });
        expect(successorRunner).not.toHaveBeenCalled();

        const database = openOpenClawStateDatabase().db;
        if (trigger === "manual-finish-retry") {
          database.exec(`
            CREATE TEMP TRIGGER reject_on_exit_receipt_finish
            BEFORE UPDATE ON cron_run_receipts
            WHEN OLD.job_id = '${job.id}' AND NEW.status != 'running'
            BEGIN SELECT RAISE(ABORT, 'receipt finish temporarily unavailable'); END;
          `);
        }
        releaseRunner.resolve({ status: "ok", summary: "late runner settled" });
        if (trigger === "manual-finish-retry") {
          await vi.waitFor(() =>
            expect(logger.warn).toHaveBeenCalledWith(
              expect.objectContaining({
                err: expect.stringContaining("receipt finish temporarily unavailable"),
              }),
              "cron: failed to finalize run receipt after execution settlement",
            ),
          );
          expect(latestReceiptStatus(storePath, job.id)).toBe("running");
          expect(settled).toBe(false);
          expect(onReserved).not.toHaveBeenCalled();
          await expect(successor.run(job.id, "force")).resolves.toEqual({
            ok: true,
            ran: false,
            reason: "already-running",
          });
          database.exec("DROP TRIGGER reject_on_exit_receipt_finish");
        }
        // Allow the retained receipt retry and foreign-owner reconciliation to run.
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(settlement).resolves.toEqual({ ok: true, ran: true });
        expect(onReserved).toHaveBeenCalledOnce();
        expect((await successor.readJob(job.id))?.enabled).toBe(false);
        expect(successorRunner).toHaveBeenCalledOnce();
      } finally {
        openOpenClawStateDatabase().db.exec("DROP TRIGGER IF EXISTS reject_on_exit_receipt_finish");
        settlementAbort.abort();
        releaseRunner.resolve({ status: "ok", summary: "late runner settled" });
        await first.catch(() => undefined);
        owner.stop();
        successor.stop();
        stoppedObserver.stop();
      }
    },
  );

  it("reserves an observed exit atomically after a competing manual run", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { storePath } = await makeStorePath();
    const job = {
      ...makeTimedJob("on-exit-manual-race", Date.now()),
      schedule: onExitSchedule,
      // Event-driven jobs have no timer slot for a competing scheduled run.
      state: {},
    };
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const manualStarted = createDeferred();
    const releaseManual = createDeferred<{ status: "ok" }>();
    const runCommandJob = vi.fn(async () => {
      if (runCommandJob.mock.calls.length === 1) {
        manualStarted.resolve();
        return await releaseManual.promise;
      }
      return { status: "ok" as const };
    });
    const service = makeService(storePath, runCommandJob);
    const controller = new AbortController();
    let manual: ReturnType<CronService["run"]> | undefined;
    const onReserved = vi.fn(() => {
      const database = openOpenClawStateDatabase().db;
      const persisted = loadedCronStoreFromRows(loadCronRows(database, cronStoreKey(storePath)))
        .store.jobs[0];
      expect(persisted?.enabled).toBe(false);
      expect(persisted?.state.queuedAtMs).toBeTypeOf("number");
      const receipt = database
        .prepare(
          "SELECT config_revision, status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? AND status = 'running'",
        )
        .get(cronStoreKey(storePath), job.id) as { config_revision: string; status: string };
      expect(receipt).toEqual({
        config_revision: resolveCronJobConfigRevision(persisted!),
        status: "running",
      });
    });
    const observedExit = service.runOnExit(job.id, {
      schedule: onExitSchedule,
      signal: controller.signal,
      commitGuard: () => {
        manual ??= service.run(job.id, "force");
      },
      onReserved,
      payload: (current) =>
        current.payload.kind === "command"
          ? { ...current.payload, argv: [...current.payload.argv, "exit-observed"] }
          : undefined,
    });
    try {
      await manualStarted.promise;
      const current = await service.readJob(job.id);
      expect(current?.enabled).toBe(true);
      expect(current?.state.nextRunAtMs).toBeUndefined();
      expect(onReserved).not.toHaveBeenCalled();
      await service.update(job.id, { payload: { kind: "command", argv: ["updated"] } });
      releaseManual.resolve({ status: "ok" });
      await manual;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(observedExit).resolves.toEqual({ ok: true, ran: true });
      expect(onReserved).toHaveBeenCalledOnce();
      expect(runCommandJob).toHaveBeenCalledTimes(2);
      expect(runCommandJob).toHaveBeenLastCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({
            payload: expect.objectContaining({ argv: ["updated", "exit-observed"] }),
          }),
        }),
      );
    } finally {
      controller.abort();
      releaseManual.resolve({ status: "ok" });
      await manual;
      await observedExit;
      service.stop();
    }
  });

  it.each(["rearm", "cancel"] as const)(
    "preserves on-exit ownership during a queued %s",
    async (action) => {
      vi.useRealTimers();
      const { storePath } = await makeStorePath();
      const job = {
        ...makeTimedJob(`on-exit-queued-${action}`, Date.now()),
        schedule: onExitSchedule,
        state: {},
        deleteAfterRun: true,
        delivery: { mode: "none" as const },
        payload: { kind: "command" as const, argv: ["original"], timeoutSeconds: 30 },
      };
      const blockers = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, (_, index) => ({
        ...makeTimedJob(`capacity-${action}-${index}`, Date.now()),
        payload: { kind: "command" as const, argv: ["blocker"], timeoutSeconds: 30 },
      }));
      await saveCronStore(storePath, { version: 1, jobs: [...blockers, job] });
      const releaseBlockers = createDeferred<{ status: "ok" }>();
      const blockersStarted = createDeferred();
      let startedBlockers = 0;
      const runCommandJob = vi.fn(async ({ job: running }: { job: CronJob }) => {
        if (running.id !== job.id) {
          if (++startedBlockers === blockers.length) {
            blockersStarted.resolve();
          }
          return await releaseBlockers.promise;
        }
        return { status: "ok" as const };
      });
      const service = makeService(storePath, runCommandJob);
      const controller = new AbortController();
      const runningBlockers = blockers.map((blocker) => service.run(blocker.id, "force"));
      let observedExit: ReturnType<CronService["runOnExit"]> | undefined;
      try {
        await blockersStarted.promise;
        expect(runCommandJob).toHaveBeenCalledTimes(blockers.length);
        expect((await service.readJob(job.id))?.state.nextRunAtMs).toBeUndefined();
        const reserved = createDeferred();
        observedExit = service.runOnExit(job.id, {
          schedule: onExitSchedule,
          signal: controller.signal,
          commitGuard: () => {},
          onReserved: () => reserved.resolve(),
          payload: (current) =>
            current.payload.kind === "command"
              ? { ...current.payload, argv: [...current.payload.argv, "exit-observed"] }
              : undefined,
        });
        await reserved.promise;
        if (action === "cancel") {
          controller.abort();
          await expect(observedExit).resolves.toEqual({ ok: true, ran: false, reason: "stopped" });
          expect(latestReceiptStatus(storePath, job.id)).toBe("skipped");
          expect((await service.readJob(job.id))?.state.queuedAtMs).toBeUndefined();
          expect(runCommandJob).toHaveBeenCalledTimes(blockers.length);
        } else {
          await service.update(job.id, { enabled: true });
          releaseBlockers.resolve({ status: "ok" });
          await expect(observedExit).resolves.toEqual({ ok: true, ran: true });
          expect(runCommandJob).toHaveBeenLastCalledWith(
            expect.objectContaining({
              job: expect.objectContaining({
                payload: expect.objectContaining({ argv: ["original", "exit-observed"] }),
              }),
            }),
          );
          expect((await service.readJob(job.id))?.enabled).toBe(true);
        }
      } finally {
        controller.abort();
        releaseBlockers.resolve({ status: "ok" });
        await Promise.all(runningBlockers);
        await observedExit;
        service.stop();
      }
    },
  );
});
