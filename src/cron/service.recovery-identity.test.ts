import { expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { waitForActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import { findCronRunRecoveryInDatabase } from "./service/run-history-recovery.js";
import { createCronRunHandle, finishCronRun } from "./service/run-history.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-recovery-identity-" });

function pendingPayload() {
  return {
    started: createDeferred(),
    completion: createDeferred<{ status: "ok"; summary: string }>(),
  };
}

function rejectSchedulerWrite(jobId: string) {
  const db = openOpenClawStateDatabase().db;
  // Leave the run active so a recorded legacy result can exercise startup recovery.
  db.exec(`
    CREATE TRIGGER reject_identity_scheduler_write
    BEFORE UPDATE ON cron_jobs
    WHEN NEW.job_id = '${jobId.replaceAll("'", "''")}'
    BEGIN SELECT RAISE(ABORT, 'scheduler write unavailable'); END;
  `);
  return () => db.exec("DROP TRIGGER IF EXISTS reject_identity_scheduler_write");
}

it.each(["predecessor", "pending", "late"] as const)(
  "recovers the pending legacy result after a %s edit",
  async (edit) => {
    const { storePath } = await makeStorePath();
    const storeKey = cronStoreKey(storePath);
    const firstStartedAt = Date.now();
    let payload = pendingPayload();
    let evaluationCount = 0;
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: true,
      state: { owner: `evaluation-${++evaluationCount}` },
    }));
    const runIsolatedAgentJob = vi.fn(async () => {
      const pending = payload;
      pending.started.resolve();
      return pending.completion.promise;
    });
    const recoveryState = createCronRegressionState({
      storePath,
      cronConfig: { triggers: { enabled: true } },
      defaultAgentId: "alpha",
      resolveDefaultAgentId: () => "alpha",
      isAgentAvailable: () => true,
      log: logger,
      evaluateCronTrigger,
      runIsolatedAgentJob,
    });
    const deps = recoveryState.deps;
    const cron = new CronService(deps);
    let restarted: CronService | undefined;
    let run: ReturnType<CronService["run"]> | undefined;
    let allowWrites: (() => void) | undefined;
    try {
      await cron.start();
      cron.pauseScheduling();
      const job = await cron.add({
        name: "receipt identity watcher",
        agentId: "alpha",
        enabled: true,
        schedule: { kind: "every", everyMs: 86_400_000, anchorMs: firstStartedAt },
        trigger: { script: "return true", once: true },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "watcher payload" },
        delivery: { mode: "none" },
        state: { triggerState: { owner: "initial" } },
      });
      const readJob = async () => (await loadCronStore(storePath)).jobs[0]!;
      const readHistory = () => readCronRunHistoryPageForTests({ storeKey, jobId: job.id }).entries;
      const startPayload = async () => {
        await cron.update(job.id, { state: { nextRunAtMs: firstStartedAt } });
        run = cron.run(job.id, "due");
        await awaitGateBeforeSettlement(
          payload.started.promise,
          run,
          "Cron run settled before its payload started",
        );
        const receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
        if (!receipt) {
          throw new Error("run was not admitted");
        }
        return receipt;
      };
      const first = await startPayload();
      if (edit === "predecessor") {
        await cron.update(job.id, { state: { triggerState: { owner: "predecessor edit" } } });
      }
      payload.completion.resolve({ status: "ok", summary: "first completed" });
      await expect(run).resolves.toEqual({ ok: true, ran: true });

      vi.setSystemTime(firstStartedAt);
      if (!cron.getJob(job.id)?.enabled) {
        await cron.update(job.id, { enabled: true });
      }
      payload = pendingPayload();
      const pending = await startPayload();
      if (edit === "pending") {
        await cron.update(job.id, { state: { triggerState: { owner: "replacement" } } });
      }
      allowWrites = rejectSchedulerWrite(job.id);
      payload.completion.resolve({ status: "ok", summary: "pending completed" });
      await expect(run).rejects.toThrow("scheduler write unavailable");
      allowWrites();
      allowWrites = undefined;
      run = undefined;
      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({ drained: true, active: 0 });
      expect((await readJob()).state.runningAtMs).toBe(firstStartedAt);
      // Released schedulers could persist history before their separate job write.
      await finishCronRun(recoveryState, {
        taskRunId: createCronRunHandle({
          state: recoveryState,
          job,
          startedAt: firstStartedAt,
          runReceipt: pending,
        }).runId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          status: "ok",
          completionStatus: "succeeded",
          summary: "pending completed",
          triggerFired: true,
          runAtMs: firstStartedAt,
          durationMs: 0,
          deliveryStatus: "not-requested",
        },
        triggerEval: { fired: true, stateChanged: true, state: { owner: "evaluation-2" } },
      });
      runOpenClawStateWriteTransaction(({ db }) => {
        // Worker-generated history IDs cannot be controlled by a host UUID spy.
        // Make the predecessor win timestamp ties so only exact receipt recovery is correct.
        const rank = db.prepare(
          "UPDATE task_runs SET task_id = ? WHERE runtime = 'cron' AND source_id = ? AND terminal_summary = ?",
        );
        expect(rank.run(`z:${job.id}`, job.id, "first completed").changes).toBe(1);
        expect(rank.run(`a:${job.id}`, job.id, "pending completed").changes).toBe(1);
      });
      const history = readHistory();
      expect(history).toHaveLength(2);
      expect(history.every((entry) => entry.status === "ok")).toBe(true);

      cron.stop();
      await cron.update(job.id, { agentId: "beta" });
      if (edit === "late") {
        await cron.update(job.id, { state: { triggerState: { owner: "replacement" } } });
      }
      const fallback = runOpenClawStateWriteTransaction(({ db }) =>
        findCronRunRecoveryInDatabase({
          database: db,
          storeKey,
          jobId: job.id,
          startedAt: firstStartedAt,
        }),
      );
      expect(fallback.receiptId).toBe(first.receiptId);

      restarted = new CronService(deps);
      await restarted.start();
      restarted.pauseScheduling();

      const { enabled, agentId, state } = await readJob();
      const pendingRetired = edit === "pending" || edit === "late";
      expect([enabled, agentId, state.lastRunStatus]).toEqual([pendingRetired, "beta", "ok"]);
      expect(state.triggerState).toEqual({
        owner: pendingRetired ? "replacement" : "evaluation-2",
      });
      expect([state.runningAtMs, state.runningReceiptId]).toEqual([undefined, undefined]);
      expect(readHistory()).toEqual(history);
      expect(evaluateCronTrigger).toHaveBeenCalledTimes(2);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    } finally {
      allowWrites?.();
      payload.completion.resolve({ status: "ok", summary: "cleanup" });
      await run?.catch(() => undefined);
      cron.stop();
      restarted?.stop();
    }
  },
);
