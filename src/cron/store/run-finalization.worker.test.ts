import { expect, it } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "./key.js";
import { finalizeCronRunsInWorker } from "./run-finalization.worker.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  prepareCronRunReceiptClaim,
} from "./run-receipt-store.test-support.js";

it("commits execution, delivery, and history once despite an owner edit and a duplicate terminal result", async () => {
  await withOpenClawTestState({ label: "cron-terminal-result" }, async (fixture) => {
    const now = Date.now();
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = createDueIsolatedJob({ id: "completed", nowMs: now, nextRunAtMs: now });
    job.payload = { kind: "command", argv: ["echo", "synthetic"] };
    job.state.runningAtMs = now;
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: "main",
      startedAtMs: now,
      observed: undefined,
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabaseForTest({
        database: db,
        prepared,
      }),
    );
    job.state.runningReceiptId = receipt.receiptId;
    const edited = { ...job, name: "edited while running", agentId: "replacement-agent" };
    await saveCronStore(storePath, { version: 1, jobs: [edited] });
    const database = openOpenClawStateDatabase();
    // Clock skew can make the pending result older than the retained history.
    // Finalization must protect its stored marker even after clearing the live job.
    const seedHistory = database.db.prepare(`
      INSERT INTO cron_run_receipts (
        receipt_id, cursor_id, store_key, job_id, config_revision, agent_id, status,
        owner_pid, owner_start_time, started_at_ms, finished_at_ms
      ) SELECT ?, (SELECT COALESCE(MAX(cursor_id), 0) + 1 FROM cron_run_receipts),
               store_key, job_id, config_revision, agent_id, 'ok',
               owner_pid, owner_start_time, ?, ?
        FROM cron_run_receipts WHERE receipt_id = ?
    `);
    for (let index = 0; index < 64; index += 1) {
      seedHistory.run(`history-${index}`, now + 100 + index, now + 101 + index, receipt.receiptId);
    }
    const finalize = (status: "ok" | "error") =>
      runWithSqliteWorkerStateContext(
        { environment: { OPENCLAW_STATE_DIR: fixture.stateDir } },
        () =>
          finalizeCronRunsInWorker(database, {
            storeKey: cronStoreKey(storePath),
            snapshot: {
              nowMs: now + 10,
              defaultAgentId: "main",
              outcomes: [
                {
                  jobId: job.id,
                  job,
                  runReceipt: receipt,
                  status,
                  completionStatus: status === "ok" ? "succeeded" : "failed",
                  deliveryState: {
                    status: "delivered",
                    delivered: true,
                    failureNotification: { status: "not-requested" },
                  },
                  startedAt: now,
                  endedAt: now + 10,
                },
              ],
            },
          }),
      );
    database.db.exec(`
      CREATE TEMP TRIGGER fail_cron_history BEFORE INSERT ON task_runs
      BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END
    `);
    expect(() => finalize("ok")).toThrow("synthetic history failure");
    expect(
      database.db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId),
    ).toEqual({ status: "running" });
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM task_runs WHERE source_id = ?")
        .get(job.id),
    ).toEqual({ count: 0 });
    expect((await loadCronStore(storePath)).jobs[0]?.state.runningReceiptId).toBe(
      receipt.receiptId,
    );
    database.db.exec("DROP TRIGGER fail_cron_history");
    expect(finalize("ok").outcome.eventPlans).toHaveLength(1);
    expect(finalize("error").outcome.eventPlans).toHaveLength(0);
    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      name: edited.name,
      agentId: edited.agentId,
      state: { lastRunStatus: "ok", lastDelivered: true, lastDeliveryStatus: "delivered" },
    });
    expect(
      database.db
        .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(receipt.receiptId),
    ).toEqual({ status: "ok" });
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM cron_run_receipts WHERE job_id = ?")
        .get(job.id),
    ).toEqual({ count: 64 });
    expect(
      database.db.prepare("SELECT status, ended_at FROM task_runs WHERE source_id = ?").all(job.id),
    ).toEqual([{ status: "succeeded", ended_at: now + 10 }]);
  });
});
