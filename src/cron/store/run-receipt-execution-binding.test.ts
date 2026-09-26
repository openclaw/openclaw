import { describe, expect, it } from "vitest";
import { ensureExecutionOwnerLifecycleBindingSchema } from "../../audit/execution-owner-lifecycle-binding-store.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createNoopLogger, installCronTestHooks } from "../service.test-harness.js";
import { saveCronStore } from "../store.js";
import { bindCronRunReceiptExecution } from "./run-receipt-execution-binding.js";
import {
  bindCronRunReceiptExecutionInDatabase,
  finishCronRunReceipt,
  finishCronRunReceiptInDatabase,
  releaseLocalCronRunReceiptOwnership,
} from "./run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "./run-receipt-store.test-support.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";

installCronTestHooks({ logger: createNoopLogger() });

describe("cron receipt execution-binding admission", () => {
  it("allocates lifecycle metadata only for a current enabled binding and rolls allocation back", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-binding-admission-" },
      async (state) => {
        const storePath = state.statePath("cron", "jobs.json");
        const job = makeCronReceiptJob("binding-admission-rollback");
        await saveCronStore(storePath, { version: 1, jobs: [job] });
        const receipt = claimCronRunReceiptForTest(storePath, job, 100);
        const { db: retainedDb } = openOpenClawStateDatabase();
        const table = () =>
          retainedDb
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name = 'execution_owner_lifecycle_bindings'",
            )
            .get();
        const binding = { contextId: "context-rollback", executionId: "execution-rollback" };
        expect(
          await bindCronRunReceiptExecution({
            admitted: {
              operationalRunInstance: { instanceId: "disabled-instance", runId: "disabled-run" },
            },
            handle: receipt,
          }),
        ).toBe("disabled");
        expect(table()).toBeUndefined();
        expect(
          runOpenClawStateWriteTransaction(({ db }) =>
            bindCronRunReceiptExecutionInDatabase(
              db,
              { ...receipt, ownerPid: receipt.ownerPid + 1 },
              binding,
              prepareCronRunReceiptWriteSchema(db),
            ),
          ),
        ).toBe("missing");
        expect(table()).toBeUndefined();
        expect(() =>
          runOpenClawStateWriteTransaction(({ db }) => {
            const receiptSchema = prepareCronRunReceiptWriteSchema(db);
            expect(receiptSchema.executionOwnerLifecycleBindings).toBe(false);
            expect(bindCronRunReceiptExecutionInDatabase(db, receipt, binding, receiptSchema)).toBe(
              "bound",
            );
            throw new Error("binding commit refused");
          }),
        ).toThrow("binding commit refused");
        expect(table()).toBeUndefined();
        expect(openOpenClawStateDatabase().db).toBe(retainedDb);
        const bind = () =>
          runOpenClawStateWriteTransaction(({ db }) =>
            bindCronRunReceiptExecutionInDatabase(
              db,
              receipt,
              binding,
              prepareCronRunReceiptWriteSchema(db),
            ),
          );
        expect(bind()).toBe("bound");
        expect(bind()).toBe("already-bound");
        expect(
          runOpenClawStateWriteTransaction(({ db }) =>
            bindCronRunReceiptExecutionInDatabase(
              db,
              receipt,
              { ...binding, executionId: "different" },
              prepareCronRunReceiptWriteSchema(db),
            ),
          ),
        ).toBe("mismatch");
        retainedDb.exec("DROP TABLE execution_owner_lifecycle_bindings");
        expect(bind()).toBe("bound");
        finishCronRunReceipt({ handle: receipt, status: "ok", finishedAtMs: 110 });
      },
    );
  });

  it.each([false, true])(
    "admits optional metadata for exact pruning and rollback (present=%s)",
    async (enabled) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "cron-prune-admission-" },
        async (state) => {
          const storePath = state.statePath("cron", "jobs.json");
          const job = makeCronReceiptJob("binding-prune-admission");
          await saveCronStore(storePath, { version: 1, jobs: [job] });
          const receipt = claimCronRunReceiptForTest(storePath, job, 100);
          const database = openOpenClawStateDatabase();
          const { db: retainedDb } = database;
          expect(
            runOpenClawStateWriteTransaction(({ db }) => prepareCronRunReceiptWriteSchema(db)),
          ).toEqual({ executionOwnerLifecycleBindings: false });
          if (enabled) {
            const sibling = openNodeSqliteDatabase(database.path);
            try {
              runSqliteImmediateTransactionSync(sibling, () => {
                ensureExecutionOwnerLifecycleBindingSchema(sibling);
                sibling
                  .prepare(
                    "INSERT INTO execution_owner_lifecycle_bindings (owner_kind, owner_id, context_id, execution_id) VALUES ('cron', ?, 'context', 'execution')",
                  )
                  .run("old-terminal");
                sibling
                  .prepare(
                    "INSERT INTO execution_owner_lifecycle_bindings (owner_kind, owner_id, context_id, execution_id) VALUES ('cron', ?, 'context', 'execution')",
                  )
                  .run("unrelated-owner");
              });
            } finally {
              sibling.close();
            }
          }
          runOpenClawStateWriteTransaction(({ db }) => {
            const insert = db.prepare(
              "INSERT INTO cron_run_receipts (receipt_id, store_key, job_id, config_revision, agent_id, status, owner_pid, owner_start_time, started_at_ms, finished_at_ms) SELECT ?, store_key, job_id, config_revision, agent_id, 'ok', owner_pid, owner_start_time, ?, ? FROM cron_run_receipts WHERE receipt_id = ?",
            );
            for (let index = 0; index < 65; index += 1) {
              insert.run(
                index === 0 ? "old-terminal" : "terminal-" + index,
                index,
                index + 1,
                receipt.receiptId,
              );
            }
          });
          const finish = (rollback: boolean) =>
            runOpenClawStateWriteTransaction(({ db }) => {
              const receiptSchema = prepareCronRunReceiptWriteSchema(db);
              expect(receiptSchema.executionOwnerLifecycleBindings).toBe(enabled);
              finishCronRunReceiptInDatabase({
                database: db,
                receiptSchema,
                handle: receipt,
                status: "ok",
                finishedAtMs: 110,
              });
              if (rollback) {
                throw new Error("prune commit refused");
              }
            });
          expect(() => finish(true)).toThrow("prune commit refused");
          expect(
            retainedDb
              .prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
              .get(receipt.receiptId),
          ).toEqual({ status: "running" });
          if (enabled) {
            expect(
              retainedDb
                .prepare(
                  "SELECT owner_id FROM execution_owner_lifecycle_bindings WHERE owner_id = 'old-terminal'",
                )
                .get(),
            ).toEqual({ owner_id: "old-terminal" });
          }
          finish(false);
          expect(
            retainedDb
              .prepare("SELECT count(*) AS count FROM cron_run_receipts WHERE job_id = ?")
              .get(job.id),
          ).toEqual({ count: 64 });
          if (enabled) {
            expect(
              retainedDb
                .prepare(
                  "SELECT owner_id FROM execution_owner_lifecycle_bindings ORDER BY owner_id",
                )
                .all(),
            ).toEqual([{ owner_id: "unrelated-owner" }]);
          }
          expect(
            runOpenClawStateWriteTransaction(({ db }) => prepareCronRunReceiptWriteSchema(db)),
          ).toEqual({ executionOwnerLifecycleBindings: enabled });
          releaseLocalCronRunReceiptOwnership(receipt);
        },
      );
    },
  );
});
