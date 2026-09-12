// A queued run whose activation fails before the run starts must release its
// own reservation. #139215: a transient store failure in that window left the
// durable queuedAtMs marker, the open receipt, and the process-local
// reservation in place, and every later tick skipped the job behind its own
// marker until restart.
import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import {
  executeQueuedCronRun,
  persistQueuedCronRunReservations,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-admission-lost-queued-" });

it("releases a reservation whose activation failed, so later ticks still run the job (#139215)", async () => {
  const store = fixtures.makeStorePath();
  const now = Date.parse("2026-08-13T18:15:00.000Z");
  const job = createDueIsolatedJob({
    id: "activation-write-failure",
    nowMs: now,
    nextRunAtMs: now,
  });
  await saveCronStore(store.storePath, { version: 1, jobs: [job] });
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => now,
    runIsolatedAgentJob,
  });
  await list(state);

  const [reserved] = await persistQueuedCronRunReservations({
    state,
    candidates: [job],
    reservedAtMs: now,
  });
  if (!reserved) {
    throw new Error("expected durable reservation");
  }
  const reservationIdentity = reserveQueuedCronRun(state, job.id, now, {
    runReceipt: reserved.runReceipt,
  });

  // Inject the queued-phase fault: the activation UPDATE that moves the queued
  // marker to runningAtMs aborts, while cleanup writes still go through. The
  // trigger is scoped to this job's rows so parallel tests stay unaffected.
  const storeKey = cronStoreKey(store.storePath);
  const database = openOpenClawStateDatabase().db;
  database.exec(`
    CREATE TEMP TRIGGER fail_cron_activation_before_start
    AFTER UPDATE OF state_json ON cron_jobs
    WHEN NEW.store_key = '${storeKey}'
      AND NEW.job_id = '${job.id}'
      AND json_extract(OLD.state_json, '$.queuedAtMs') IS NOT NULL
      AND json_extract(NEW.state_json, '$.runningAtMs') IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'injected activation write failure');
    END;
  `);

  await expect(
    executeQueuedCronRun({
      state,
      jobId: job.id,
      reservedAtMs: now,
      reservationIdentity,
      onNotRunnable: vi.fn(),
    }),
  ).rejects.toThrow();

  // The producer owns its reservation: with the run never activated, the
  // marker, receipt, and local claim must be released instead of wedging the
  // job behind its own queued marker.
  const persisted = (await loadCronStore(store.storePath)).jobs[0];
  expect(persisted?.state.queuedAtMs).toBeUndefined();
  const receipt = runOpenClawStateWriteTransaction(({ db }) =>
    db
      .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
      .get(reserved.runReceipt.receiptId),
  ) as { status: string } | undefined;
  expect(receipt?.status).toBe("skipped");
  database.exec("DROP TRIGGER IF EXISTS fail_cron_activation_before_start");

  // User-visible boundary: the next timer tick re-queues and runs the job
  // instead of silently swallowing every slot until restart.
  await onTimer(state);
  expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
  const afterTick = (await loadCronStore(store.storePath)).jobs[0];
  expect(afterTick?.state).toMatchObject({ lastRunStatus: "ok" });
  expect(afterTick?.state.queuedAtMs).toBeUndefined();
  stop(state);
});
