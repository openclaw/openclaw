import { expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { saveCronStore } from "../store.js";
import { cronStoreKey } from "./key.js";
import { finalizeCronRunsInWorker } from "./run-finalization.worker.js";
import {
  CronRunReceiptRevisionError,
  releaseLocalCronRunReceiptOwnership,
} from "./run-receipt-store.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  prepareCronRunReceiptClaim,
} from "./run-receipt-store.test-support.js";

it.each(["confirmed", "aborted-open"] as const)(
  "reports a finalization receipt revision only after a usable rollback: %s",
  async (rollback) => {
    await withOpenClawTestState({ label: "cron-finalization-rollback" }, async (fixture) => {
      const now = Date.now();
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "edited-receipt", nowMs: now, nextRunAtMs: now });
      job.payload = { kind: "command", argv: ["echo", "synthetic"] };
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
          resolveAgentId: () => "main",
        }),
      );
      await saveCronStore(storePath, {
        version: 1,
        jobs: [{ ...job, agentId: "replacement-agent" }],
      });
      const database = openOpenClawStateDatabase();
      const snapshot = () => ({
        job: database.db.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").get(job.id),
        receipt: database.db
          .prepare("SELECT * FROM cron_run_receipts WHERE receipt_id = ?")
          .get(receipt.receiptId),
      });
      const before = snapshot();
      expect(before.receipt).toMatchObject({ status: "running" });
      const exec = database.db.exec.bind(database.db);
      let rollbackFailed = false;
      const statement = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
        const result = exec(sql);
        if (rollback === "aborted-open" && sql === "ROLLBACK") {
          rollbackFailed = true;
          throw new Error("rollback completion unavailable");
        }
        return result;
      });
      const close =
        rollback === "aborted-open"
          ? vi.spyOn(database.db, "close").mockImplementation(() => {
              throw new Error("native close unavailable");
            })
          : undefined;
      const finalize = () =>
        runWithSqliteWorkerStateContext(
          { environment: { OPENCLAW_STATE_DIR: fixture.stateDir } },
          () =>
            finalizeCronRunsInWorker(database, {
              storeKey: cronStoreKey(storePath),
              jobIds: [job.id],
              receipts: [
                {
                  terminal: { handle: receipt, status: "ok", finishedAtMs: now + 1 },
                  allowMissingJob: false,
                  allowUnavailable: false,
                },
              ],
              snapshot: {
                nowMs: now + 1,
                defaultAgentId: "main",
                outcomes: [
                  {
                    jobId: job.id,
                    job,
                    status: "ok",
                    completionStatus: "succeeded",
                    deliveryState: {
                      status: "not-requested",
                      failureNotification: { status: "not-requested" },
                    },
                    startedAt: now,
                    endedAt: now + 1,
                  },
                ],
                deferredReceiptIds: [],
              },
            }),
        );
      try {
        if (rollback === "confirmed") {
          expect(finalize()).toEqual({
            receiptRevision: {
              receiptId: receipt.receiptId,
              message: "cron run configuration changed",
              reason: "revision-changed",
            },
          });
          expect(() => assertTransactionUsable(database.db)).not.toThrow();
        } else {
          let failure: unknown;
          try {
            finalize();
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(CronRunReceiptRevisionError);
          expect(failure).toMatchObject({
            receiptId: receipt.receiptId,
            reason: "revision-changed",
          });
          expect(rollbackFailed).toBe(true);
          let unusable: unknown;
          try {
            assertTransactionUsable(database.db);
          } catch (error) {
            unusable = error;
          }
          expect(unusable).toBe(failure);
        }
        expect(database.db.isOpen).toBe(true);
        expect(database.db.isTransaction).toBe(false);
        expect(snapshot()).toEqual(before);
      } finally {
        statement.mockRestore();
        close?.mockRestore();
        releaseLocalCronRunReceiptOwnership(receipt);
      }
    });
  },
);
