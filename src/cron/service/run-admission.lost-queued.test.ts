// Producer cleanup after a pre-activation failure, adapted from holny's PR #141008.
// The injected SQLite fault and mock execution are not proof of receipt-free missing ticks.
import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import {
  cleanupQueuedCronRunReservations,
  executeQueuedCronRun,
  persistQueuedCronRunReservations,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-admission-lost-queued-" });

async function withQueuedReservations(
  run: (context: Awaited<ReturnType<typeof createQueuedReservations>>) => Promise<void>,
) {
  const context = await createQueuedReservations();
  try {
    await run(context);
  } finally {
    await releaseFixtureReservations(context.state);
  }
}

async function releaseFixtureReservations(state: ReturnType<typeof createCronRegressionState>) {
  try {
    await cleanupQueuedCronRunReservations({
      state,
      reservations: [...state.queuedRunReservationsByJobId].map(([jobId, reservation]) => ({
        jobId,
        reservationIdentity: reservation.identity,
      })),
    });
  } finally {
    stop(state);
  }
}

async function createQueuedReservations() {
  const store = fixtures.makeStorePath();
  const now = Date.now();
  const job = createDueIsolatedJob({
    id: "activation-write-failure",
    nowMs: now,
    nextRunAtMs: now,
  });
  const sibling = createDueIsolatedJob({
    id: "untouched-sibling",
    nowMs: now,
    nextRunAtMs: now + 60_000,
  });
  await saveCronStore(store.storePath, { version: 1, jobs: [job, sibling] });
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => now,
    defaultAgentId: "main",
    runIsolatedAgentJob,
  });
  try {
    await list(state);
    const reserved = await persistQueuedCronRunReservations({
      state,
      candidates: [job, sibling],
      reservedAtMs: now,
    });
    for (const item of reserved) {
      reserveQueuedCronRun(state, item.job.id, now, { runReceipt: item.runReceipt });
    }
    const ownership = state.queuedRunReservationsByJobId.get(job.id);
    const siblingOwnership = state.queuedRunReservationsByJobId.get(sibling.id);
    if (!ownership || !siblingOwnership) {
      throw new Error("expected both durable reservations");
    }
    const database = openOpenClawStateDatabase().db;
    const receipt = (receiptId: string) =>
      database
        .prepare(
          "SELECT receipt_id, status, started_at_ms, finished_at_ms FROM cron_run_receipts WHERE receipt_id = ?",
        )
        .get(receiptId);
    return {
      store,
      now,
      job,
      sibling,
      state,
      ownership,
      siblingOwnership,
      database,
      receipt,
      runIsolatedAgentJob,
    };
  } catch (error) {
    await releaseFixtureReservations(state);
    throw error;
  }
}

it("releases the exact failed activation before another tick without releasing its sibling", async () => {
  await withQueuedReservations(async (context) => {
    const {
      store,
      now,
      job,
      sibling,
      state,
      ownership,
      siblingOwnership,
      database,
      receipt,
      runIsolatedAgentJob,
    } = context;
    const siblingBefore = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === sibling.id,
    );
    const siblingReceiptBefore = receipt(siblingOwnership.runReceipt.receiptId);
    // Only activation of this partition/job fails; cleanup writes remain usable.
    database.exec(`
      CREATE TEMP TRIGGER fail_cron_activation_before_start
      AFTER UPDATE OF state_json ON cron_jobs
      WHEN NEW.store_key = '${cronStoreKey(store.storePath).replaceAll("'", "''")}'
        AND NEW.job_id = '${job.id}'
        AND json_extract(OLD.state_json, '$.queuedAtMs') IS NOT NULL
        AND json_extract(NEW.state_json, '$.runningAtMs') IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected activation write failure');
      END;
    `);
    try {
      await expect(
        executeQueuedCronRun({
          state,
          jobId: job.id,
          reservedAtMs: now,
          reservationIdentity: ownership.identity,
          onNotRunnable: async () => {
            throw new Error("expected runnable job");
          },
        }),
      ).rejects.toThrow("injected activation write failure");

      // This is before onTimer's batch-tail/recovery safety net can run.
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(state.runAdmission.active).toBe(0);
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(receipt(ownership.runReceipt.receiptId)).toMatchObject({
        receipt_id: ownership.runReceipt.receiptId,
        status: "skipped",
        started_at_ms: now,
        finished_at_ms: now,
      });
      expect(state.queuedRunReservationsByJobId.get(sibling.id)).toBe(siblingOwnership);
      const siblingAfter = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === sibling.id,
      );
      expect(siblingAfter).toEqual(siblingBefore);
      expect(receipt(siblingOwnership.runReceipt.receiptId)).toEqual(siblingReceiptBefore);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS fail_cron_activation_before_start");
    }

    // Exercise the real timer scheduler after the producer has already cleaned up.
    await onTimer(state);
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
    const afterTick = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(afterTick?.state).toMatchObject({ lastRunStatus: "ok" });
    expect(afterTick?.state.queuedAtMs).toBeUndefined();
    expect(afterTick?.state.runningAtMs).toBeUndefined();
    expect(receipt(ownership.runReceipt.receiptId)).toMatchObject({ status: "skipped" });
  });
});

it("releases its reservation and preserves a pre-activation admission error", async () => {
  await withQueuedReservations(async (context) => {
    const { state, job, now, ownership, receipt, runIsolatedAgentJob } = context;
    const error = new Error("admission callback failed");
    await expect(
      executeQueuedCronRun({
        state,
        jobId: job.id,
        reservedAtMs: now,
        reservationIdentity: ownership.identity,
        isUnavailable: () => {
          throw error;
        },
        onNotRunnable: async () => {
          throw new Error("unexpected runnable check");
        },
      }),
    ).rejects.toBe(error);
    expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
    expect(state.runAdmission.active).toBe(0);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(receipt(ownership.runReceipt.receiptId)).toMatchObject({ status: "skipped" });
  });
});

it("does not release a replacement identity when the old admission callback fails", async () => {
  await withQueuedReservations(async (context) => {
    const { store, state, job, now, ownership, receipt, runIsolatedAgentJob } = context;
    const error = new Error("old admission callback failed");
    let replacementIdentity: object | undefined;
    const receiptBefore = receipt(ownership.runReceipt.receiptId);
    await expect(
      executeQueuedCronRun({
        state,
        jobId: job.id,
        reservedAtMs: now,
        reservationIdentity: ownership.identity,
        isUnavailable: () => {
          // Keep the timestamp and receipt equal: only the local identity distinguishes owners.
          replacementIdentity = reserveQueuedCronRun(state, job.id, now, {
            runReceipt: ownership.runReceipt,
          });
          throw error;
        },
        onNotRunnable: async () => {
          throw new Error("unexpected runnable check");
        },
      }),
    ).rejects.toBe(error);
    expect(replacementIdentity).toBeDefined();
    expect(state.queuedRunReservationsByJobId.get(job.id)?.identity).toBe(replacementIdentity);
    const persisted = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(persisted?.state.queuedAtMs).toBe(now);
    expect(receipt(ownership.runReceipt.receiptId)).toEqual(receiptBefore);
    expect(state.runAdmission.active).toBe(0);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });
});
