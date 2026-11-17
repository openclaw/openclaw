import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { cronTestDeps } from "./service.fixture-builders.test-support.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { drainCronRunQueue, waitForCronRunQueue } from "./service/run-queue.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { createCronScheduledRunId } from "./store/run-request-id.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-resume-storage-",
  fakeTimers: false,
});

it("contains a resumed queue storage failure and retains its durable request for retry", async () => {
  const now = Date.now();
  const { storePath } = await makeStorePath();
  const job = {
    ...createDueIsolatedJob({ id: "resume-storage", nowMs: now, nextRunAtMs: now + 60_000 }),
    agentId: "main",
    payload: { kind: "command" as const, argv: ["synthetic", "resume-storage"] },
  };
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
  const { cron, state } = createCronServiceWithStateForTest(
    cronTestDeps({ storePath, nowMs: () => now, log: logger, runCommandJob }),
  );
  const receiptId = createCronScheduledRunId(storePath, job.id, now);
  const trigger = (create: boolean) =>
    runOpenClawStateWriteTransaction(({ db }) => {
      if (create) {
        db.exec(
          "CREATE TRIGGER reject_resumed_cron_launch BEFORE UPDATE ON cron_jobs " +
            "WHEN NEW.job_id = 'resume-storage' AND json_extract(NEW.state_json, '$.runningAtMs') IS NOT NULL " +
            "BEGIN SELECT RAISE(ABORT, 'injected resume storage failure'); END;",
        );
      } else {
        db.exec("DROP TRIGGER IF EXISTS reject_resumed_cron_launch");
      }
    });
  const receipt = () =>
    runOpenClawStateWriteTransaction(({ db }) =>
      db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?").get(receiptId),
    );
  try {
    await cron.start();
    cron.pauseScheduling();
    const context = captureOpenClawStateWorkerContext();
    const requested = await executeOpenClawStateWorker(context, {
      type: "cron.requestRuns",
      input: {
        storeKey: storePath,
        nowMs: now,
        defaultAgentId: "main",
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
    state.store = await loadCronStore(storePath);
    trigger(true);
    cron.resumeScheduling();
    await waitForCronRunQueue(state).catch(() => undefined);
    await nextTurn();
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.stringContaining("injected resume storage failure") },
      "cron: queue drain delayed",
    );
    expect(state.stopped).toBe(false);
    expect(runCommandJob).not.toHaveBeenCalled();
    expect(receipt()).toEqual({ status: "running" });
    expect((await loadCronStore(storePath)).jobs[0]?.state.queuedAtMs).toBe(now);
    await expect(drainCronRunQueue(state)).rejects.toThrow("injected resume storage failure");
    trigger(false);
    await drainCronRunQueue(state);
    await waitForCronRunQueue(state);
    expect(runCommandJob).toHaveBeenCalledOnce();
    expect(receipt()).toEqual({ status: "ok" });
  } finally {
    trigger(false);
    cron.stop();
    await state.schedulerDrain;
    await state.deps.scheduler.stop();
  }
});
