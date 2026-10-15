import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { cronRunLogEntryToDetail } from "../run-history-detail.js";
import { projectCronRunHistoryPage } from "../run-history.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { readCronRunRecords } from "../store/read-only.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import { createCronScheduledRunId } from "../store/run-request-id.js";
import type { CronJob } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-run-recovery-" });
const now = 1_800_000_000_000;

function job(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["echo", "synthetic"] },
    delivery: { mode: "none" },
    state: { nextRunAtMs: now },
    ...overrides,
  };
}

async function recoveryStore(jobs: CronJob[]) {
  const { storePath } = await makeStorePath();
  await writeCronStoreSnapshot({ storePath, jobs });
  const context = captureOpenClawStateWorkerContext();
  const storeKey = cronStoreKey(storePath);
  return {
    storePath,
    storeKey,
    context,
    recover: () =>
      executeOpenClawStateWorker(context, {
        type: "cron.recoverRuns",
        input: { storeKey, nowMs: now + 1_000 },
      }),
    request: (
      entry: CronJob,
      receiptId = `manual:${storeKey}:${entry.id}`,
      requestRunId?: string,
    ) =>
      executeOpenClawStateWorker(context, {
        type: "cron.requestRuns",
        input: {
          storeKey,
          nowMs: now,
          requests: [
            {
              jobId: entry.id,
              receiptId,
              requestRunId,
              configRevision: resolveCronJobConfigRevision(entry),
              mode: "force",
              preserveSchedule: true,
            },
          ],
        },
      }),
    history: async () =>
      projectCronRunHistoryPage(await readCronRunRecords(storeKey), { storeKey }).entries,
  };
}

async function activateManual(
  store: Awaited<ReturnType<typeof recoveryStore>>,
  entry: CronJob,
  publicRunId?: string,
) {
  const requested = await store.request(entry, undefined, publicRunId);
  expect(requested.rejected).toEqual([]);
  expect(requested.accepted).toHaveLength(1);
  const request = requested.accepted[0]!;
  const launch = await executeOpenClawStateWorker(store.context, {
    type: "cron.drainQueue",
    input: {
      storeKey: store.storeKey,
      nowMs: now,
      maxConcurrentRuns: 10,
      requests: [
        {
          receiptId: request.runReceipt.receiptId,
          mode: "force",
        },
      ],
    },
  });
  expect(launch.skipped).toEqual([]);
  expect(launch.launches).toHaveLength(1);
  return launch.launches[0]!.runReceipt;
}

async function record(
  store: Awaited<ReturnType<typeof recoveryStore>>,
  receipt: CronRunReceiptHandle,
  entry: {
    status: "ok";
    delivered?: boolean;
    deliveryStatus?: "delivered";
    nextRunAtMs?: number;
  },
  triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown },
) {
  await executeOpenClawStateWorker(store.context, {
    type: "cron.recordRun",
    input: {
      storeKey: store.storeKey,
      jobId: receipt.jobId,
      runId: `cron:${receipt.jobId}:${now}:${receipt.receiptId}`,
      agentId: receipt.agentId,
      startedAt: now,
      endedAt: now + 500,
      status: "succeeded",
      detail: cronRunLogEntryToDetail(
        {
          ts: now + 500,
          jobId: receipt.jobId,
          action: "finished",
          runAtMs: now,
          durationMs: 500,
          completionStatus: "succeeded",
          ...entry,
        },
        { storeKey: store.storeKey, triggerEval },
      ),
    },
  });
}

describe("worker-owned startup recovery", () => {
  it("records an interrupted one-shot durably and never replays its uncertain payload", async () => {
    const entry = job("one-shot", { schedule: { kind: "at", at: new Date(now).toISOString() } });
    const store = await recoveryStore([entry]);
    await activateManual(store, entry, "acknowledged-manual-run");
    const runCommandJob = vi.fn();
    const onEvent = vi.fn();
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath: store.storePath,
      cronEnabled: true,
      nowMs: () => now + 1_000,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      runCommandJob,
      onEvent,
    });
    try {
      await start(state);
      expect((await loadCronStore(store.storePath)).jobs[0]).toMatchObject({
        enabled: false,
        state: { lastRunStatus: "error", lastError: "cron: job interrupted by gateway restart" },
      });
      expect(await store.history()).toMatchObject([
        {
          runId: "acknowledged-manual-run",
          status: "error",
          deliveryStatus: "unknown",
        },
      ]);
      expect(runCommandJob).not.toHaveBeenCalled();
      expect(onEvent.mock.calls.filter(([event]) => event.action === "finished")).toHaveLength(1);
      stop(state);
      await state.schedulerDrain;
      await start(state);
      expect(await store.history()).toHaveLength(1);
      expect(runCommandJob).not.toHaveBeenCalled();
    } finally {
      stop(state);
      await state.schedulerDrain;
    }
  });

  it("finishes an existing legacy history row while preserving the acknowledged public ID", async () => {
    const entry = job("legacy-active");
    const store = await recoveryStore([entry]);
    const receipt = await activateManual(store, entry, "legacy-public-run");
    await record(store, receipt, { status: "ok" });
    const internalRunId = `cron:${entry.id}:${now}:${receipt.receiptId}`;
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE task_runs SET status = 'running', ended_at = NULL, detail_json = ? WHERE runtime = 'cron' AND run_id = ?",
      )
      .run(JSON.stringify({ storeKey: store.storeKey }), internalRunId);
    const previous = (await readCronRunRecords(store.storeKey)).find(
      (row) => row.runId === internalRunId,
    )!;
    expect(previous.endedAt).toBeUndefined();
    await store.recover();
    const rows = (await readCronRunRecords(store.storeKey)).filter((row) => row.jobId === entry.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: previous.id, runId: internalRunId, status: "failed" });
    expect(
      projectCronRunHistoryPage(rows, { storeKey: store.storeKey, runId: "legacy-public-run" })
        .entries,
    ).toMatchObject([{ status: "error", runId: "legacy-public-run" }]);
  });

  it.each([false, true])(
    "keeps durable accounting when the active job row is missing (recorded result: %s)",
    async (recorded) => {
      const entry = job("removed-active");
      const store = await recoveryStore([entry]);
      const receipt = await activateManual(store, entry, "removed-manual-run");
      if (recorded) {
        await record(store, receipt, {
          status: "ok",
          delivered: true,
          deliveryStatus: "delivered",
        });
      }
      await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [] });
      const before = await store.history();
      const outcome = await store.recover();
      expect(outcome.jobs).toEqual([]);
      if (recorded) {
        expect(await store.history()).toEqual(before);
        expect(outcome.interruptedRuns).toEqual([]);
      } else {
        expect(await store.history()).toMatchObject([
          {
            jobId: entry.id,
            runId: "removed-manual-run",
            status: "error",
            error: "cron: job interrupted by gateway restart",
          },
        ]);
        expect(outcome.interruptedRuns).toMatchObject([
          { jobId: entry.id, runId: "removed-manual-run" },
        ]);
      }
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
          .get(receipt.receiptId),
      ).toMatchObject({ status: recorded ? "ok" : "interrupted" });
      await store.recover();
      expect(await store.history()).toHaveLength(1);
    },
  );

  it("restores a recorded result and primary delivery before one-shot deletion", async () => {
    const entry = job("complete", {
      schedule: { kind: "at", at: new Date(now).toISOString() },
      deleteAfterRun: true,
    });
    const store = await recoveryStore([entry]);
    const receipt = await activateManual(store, entry);
    await record(store, receipt, { status: "ok", delivered: true, deliveryStatus: "delivered" });
    const outcome = await store.recover();
    expect(outcome.removedJobIds).toEqual([entry.id]);
    expect(outcome.interruptedRuns).toEqual([]);
    expect((await loadCronStore(store.storePath)).jobs).toEqual([]);
    expect(await store.history()).toMatchObject([{ status: "ok", delivered: true }]);
  });

  it("preserves a replacement one-shot committed while its prior run was active", async () => {
    const entry = job("replacement", { schedule: { kind: "at", at: new Date(now).toISOString() } });
    const store = await recoveryStore([entry]);
    await activateManual(store, entry);
    await executeOpenClawStateWorker(store.context, {
      type: "cron.mutateJobs",
      input: {
        storeKey: store.storeKey,
        jobMutation: {
          kind: "update",
          id: entry.id,
          patch: { schedule: { kind: "at", at: new Date(now + 60_000).toISOString() } },
          options: { captured: false },
        },
        snapshot: { nowMs: now + 100 },
      },
    });
    const outcome = await store.recover();
    expect(outcome.jobs[0]).toMatchObject({ enabled: true, state: { nextRunAtMs: now + 60_000 } });
    expect(outcome.interruptedRuns).toHaveLength(1);
  });

  it("retains timed queued work but skips a request whose transient context was lost", async () => {
    const timed = job("timed");
    const manual = job("manual");
    const store = await recoveryStore([timed, manual]);
    await store.request(timed, createCronScheduledRunId(store.storeKey, timed.id, now));
    await store.request(manual);
    const outcome = await store.recover();
    expect(outcome.jobs.find((entry) => entry.id === timed.id)?.state.queuedAtMs).toBe(now);
    expect(outcome.jobs.find((entry) => entry.id === manual.id)?.state.queuedAtMs).toBeUndefined();
    expect(await store.history()).toMatchObject([
      {
        jobId: manual.id,
        status: "skipped",
        error: "cron: queued request lost its launch context",
      },
    ]);
  });

  it("rolls back history and receipt retirement if the interrupted job cannot commit", async () => {
    const entry = job("rollback");
    const store = await recoveryStore([entry]);
    await activateManual(store, entry);
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TRIGGER reject_recovery BEFORE UPDATE ON cron_jobs
      WHEN NEW.job_id = 'rollback' BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END`);
    try {
      await expect(store.recover()).rejects.toThrow("injected recovery failure");
      expect((await loadCronStore(store.storePath)).jobs[0]?.state.runningAtMs).toBe(now);
      expect(await store.history()).toEqual([]);
    } finally {
      db.exec("DROP TRIGGER reject_recovery");
    }
    expect((await store.recover()).interruptedRuns).toHaveLength(1);
    expect(await store.history()).toHaveLength(1);
  });
});
