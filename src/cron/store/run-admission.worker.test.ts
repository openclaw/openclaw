import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { saveCronStore } from "../store.js";
import { cronStoreKey } from "./key.js";
import { reserveCronRunsInWorker } from "./run-admission.worker.js";
import {
  CronRunReceiptConflictError,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "./run-receipt-store.js";
import { claimCronRunReceiptInDatabaseForTest } from "./run-receipt-store.test-support.js";

it.each(["confirmed", "aborted-open"] as const)(
  "reports a reservation conflict only after a usable rollback: %s",
  async (rollback) => {
    await withOpenClawTestState({ label: "cron-conflict-rollback" }, async (fixture) => {
      const now = Date.now();
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "foreign-receipt", nowMs: now, nextRunAtMs: now });
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
      const candidate = prepareCronRunReceiptClaim({
        storePath,
        job,
        agentId: "main",
        startedAtMs: now + 1,
        observed: receipt,
      });
      const database = openOpenClawStateDatabase();
      const admission = vi
        .spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission")
        .mockImplementation((request) => {
          expect(request.stage).toBe("transaction");
          if (!isRecord(request.facts) || !(request.facts.preparationPort instanceof MessagePort)) {
            throw new Error("Reservation did not request host preparation");
          }
          request.facts.preparationPort.postMessage(
            { defaultAgentId: "main", claims: [candidate], replacements: [] },
            [],
          );
        });
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
      const reserve = () =>
        runWithSqliteWorkerStateContext(
          { environment: { OPENCLAW_STATE_DIR: fixture.stateDir } },
          () =>
            reserveCronRunsInWorker(database, {
              nonce: "conflict-rollback",
              storeKey: cronStoreKey(storePath),
              proposals: [
                {
                  jobId: job.id,
                  enabled: job.enabled,
                  configRevision: resolveCronJobConfigRevision(job),
                  nextRunAtMs: job.state.nextRunAtMs,
                  immediate: true,
                },
              ],
              reservedAtMs: now + 1,
              preserveSchedule: false,
              scheduleOwnershipAtMs: now + 1,
              onExit: false,
            }),
        );
      try {
        if (rollback === "confirmed") {
          expect(reserve()).toMatchObject({
            nonce: "conflict-rollback",
            conflict: { receiptId: receipt.receiptId },
          });
          expect(() => assertTransactionUsable(database.db)).not.toThrow();
        } else {
          expect(reserve).toThrow(CronRunReceiptConflictError);
          expect(rollbackFailed).toBe(true);
          expect(() => assertTransactionUsable(database.db)).toThrow(CronRunReceiptConflictError);
        }
        expect(database.db.isOpen).toBe(true);
        expect(database.db.isTransaction).toBe(false);
        expect(database.db.prepare("SELECT receipt_id FROM cron_run_receipts").all()).toEqual([
          { receipt_id: receipt.receiptId },
        ]);
      } finally {
        admission.mockRestore();
        statement.mockRestore();
        close?.mockRestore();
        releaseLocalCronRunReceiptOwnership(receipt);
      }
    });
  },
);
