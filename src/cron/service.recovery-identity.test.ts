import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { waitForActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import { proposeCronRunRecovery, recoverCronRunProposal } from "./service/run-recovery.js";
import { createCronServiceState, type CronServiceDeps } from "./service/state.js";
import { findCronTaskRunRecoveryInDatabase } from "./service/task-runs.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-recovery-identity-" });
let uuidCounter = 0xffffffffffff;

function pendingPayload() {
  return {
    started: createDeferred(),
    completion: createDeferred<{ status: "ok"; summary: string }>(),
  };
}

function rejectSchedulerWrite(jobId: string) {
  const db = openOpenClawStateDatabase().db;
  // The terminal task commits independently of the scheduler's outcome write.
  db.exec(`
    CREATE TEMP TRIGGER reject_identity_scheduler_write
    BEFORE UPDATE ON cron_jobs
    WHEN NEW.job_id = '${jobId.replaceAll("'", "''")}'
    BEGIN SELECT RAISE(ABORT, 'scheduler write unavailable'); END;
  `);
  return () => db.exec("DROP TRIGGER IF EXISTS reject_identity_scheduler_write");
}

describe("cron recovery run identity", () => {
  it.each([
    { name: "retired predecessor", edit: "predecessor", advanceMs: 0, staleProposal: false },
    { name: "retired pending run", edit: "pending", advanceMs: 0, staleProposal: false },
    { name: "edit after receipt closure", edit: "late", advanceMs: 0, staleProposal: false },
    { name: "unedited pending run", edit: "none", advanceMs: 0, staleProposal: false },
    { name: "advancing clock", edit: "predecessor", advanceMs: 1, staleProposal: false },
    { name: "stale predecessor proposal", edit: "none", advanceMs: 0, staleProposal: true },
  ] as const)("recovers the pending run with $name", async ({ edit, advanceMs, staleProposal }) => {
    // Keep real admission/task producers, but force their UUID tie-break order.
    const uuids = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      const suffix = (uuidCounter--).toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${suffix}`;
    });
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
    const deps: CronServiceDeps = {
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      defaultAgentId: "alpha",
      resolveDefaultAgentId: () => "alpha",
      isAgentAvailable: () => true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      evaluateCronTrigger,
      runIsolatedAgentJob,
    };
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
      const readHistory = () => readCronTaskRunHistoryPage({ storeKey, jobId: job.id }).entries;
      const recoveryState = createCronServiceState(deps);

      await cron.update(job.id, { state: { nextRunAtMs: firstStartedAt } });
      run = cron.run(job.id, "due");
      await payload.started.promise;
      const first = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      if (!first) {
        throw new Error("predecessor was not admitted");
      }
      const predecessorProposal = proposeCronRunRecovery(
        recoveryState,
        job.id,
        undefined,
        firstStartedAt,
      );
      if (edit === "predecessor") {
        await cron.update(job.id, { state: { triggerState: { owner: "predecessor edit" } } });
      }
      payload.completion.resolve({ status: "ok", summary: "first completed" });
      await expect(run).resolves.toEqual({ ok: true, ran: true });

      const pendingStartedAt = firstStartedAt + advanceMs;
      vi.setSystemTime(pendingStartedAt);
      if (!cron.getJob(job.id)?.enabled) {
        await cron.update(job.id, { enabled: true });
      }
      await cron.update(job.id, { state: { nextRunAtMs: pendingStartedAt } });
      payload = pendingPayload();
      run = cron.run(job.id, "due");
      await payload.started.promise;
      const pending = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      if (!pending) {
        throw new Error("pending run was not admitted");
      }
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
      expect((await readJob()).state.runningAtMs).toBe(pendingStartedAt);
      const history = readHistory();
      expect(history).toHaveLength(2);
      expect(history.every((entry) => entry.status === "ok")).toBe(true);

      cron.stop();
      await cron.update(job.id, { agentId: "beta" });
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      if (edit === "late") {
        await cron.update(job.id, { state: { triggerState: { owner: "replacement" } } });
      }
      const fallback = runOpenClawStateWriteTransaction(({ db }) =>
        findCronTaskRunRecoveryInDatabase({
          database: db,
          storeKey,
          jobId: job.id,
          startedAt: pendingStartedAt,
        }),
      );
      expect(fallback.receiptId).toBe(advanceMs === 0 ? first.receiptId : pending.receiptId);

      if (staleProposal) {
        const before = await readJob();
        expect(recoverCronRunProposal(recoveryState, predecessorProposal, "startup")).toEqual({
          kind: "superseded",
        });
        expect(await readJob()).toEqual(before);
      }
      restarted = new CronService(deps);
      await restarted.start();
      restarted.pauseScheduling();

      const recovered = await readJob();
      const pendingRetired = edit === "pending" || edit === "late";
      expect(recovered.enabled).toBe(pendingRetired);
      expect(recovered.state.triggerState).toEqual({
        owner: pendingRetired ? "replacement" : "evaluation-2",
      });
      expect(recovered.agentId).toBe("beta");
      expect(recovered.state.lastRunStatus).toBe("ok");
      expect(recovered.state.runningAtMs).toBeUndefined();
      expect(recovered.state.runningReceiptId).toBeUndefined();
      expect(readHistory()).toEqual(history);
      expect(evaluateCronTrigger).toHaveBeenCalledTimes(2);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    } finally {
      allowWrites?.();
      payload.completion.resolve({ status: "ok", summary: "cleanup" });
      await run?.catch(() => undefined);
      cron.stop();
      restarted?.stop();
      uuids.mockRestore();
    }
  });
});
