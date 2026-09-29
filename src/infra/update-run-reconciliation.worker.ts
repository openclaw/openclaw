import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { inspectNewerRecoveryHistory, needsPostCoreRepair } from "./update-run-activity.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { LEGACY_UPDATE_RUN_EXPIRED_REASON } from "./update-run-legacy-expiry.js";
import {
  canReconcileUpdateRunCandidates,
  readUpdateRunRecord,
  readUpdateRuns,
} from "./update-run-read.kernel.js";
import { inspectUpdateRunReconciliation } from "./update-run-reconciliation.read.js";
import type {
  UpdateRunReconciliationOperations,
  UpdateRunReconciliationResult,
} from "./update-run-reconciliation.types.js";
import { finishUpdateRunRecord, type UpdateRunRecord } from "./update-run-record.js";
import { persistRun, updateRunLedgerSchema as schema, upsertStep } from "./update-run-write.js";

type LedgerDatabase = Pick<DB, "update_runs">;

export function reconcileUpdateRunCandidatesInWorker(
  command: UpdateRunReconciliationOperations["updateRuns.reconcile"]["input"],
  stateOptions: UpdateRunLedgerOptions,
  assertCurrent: (stage: "transaction" | "commit") => void,
): UpdateRunReconciliationResult {
  const { candidates, selection: input, busyTimeoutMs, redactPaths } = command;
  const options = { ...stateOptions, busyTimeoutMs, redactPaths };
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent("transaction");
      const selected = candidates.flatMap(({ record }) => {
        const current = readUpdateRunRecord(db, record.runId);
        return current ? [inspectUpdateRunReconciliation(db, current, input)] : [];
      });
      const current = selected.map(({ record }) => record);
      if (input.repairHistorySinceMs !== undefined) {
        const history = inspectNewerRecoveryHistory(
          input.repairHistorySinceMs,
          readUpdateRuns(db, { limit: 100 }),
        );
        if (
          current.some((record) => record.status === "running" && needsPostCoreRepair(record)) ||
          history.postCoreRuns.length ||
          history.incomplete
        ) {
          throw new Error(
            "Update history changed during inspection and now needs post-core maintenance. Retry openclaw update repair; if the managed Gateway cannot stop, run openclaw gateway stop first.",
          );
        }
      }
      if (
        !canReconcileUpdateRunCandidates(selected, input) ||
        (input.requireAllActive &&
          executeSqliteQueryTakeFirstSync(
            db,
            getNodeSqliteKysely<LedgerDatabase>(db)
              .selectFrom("update_runs")
              .select("run_id")
              .where("status", "=", "running")
              .where(
                "run_id",
                "not in",
                candidates.map(({ record }) => record.runId),
              )
              .limit(1),
          ))
      ) {
        assertCurrent("commit");
        return { current, reconciled: [] };
      }
      const reconciled: UpdateRunRecord[] = [];
      const result = {
        current: selected.map(({ record, rule }) => {
          if (!rule || (input.legacyOnly && rule !== LEGACY_UPDATE_RUN_EXPIRED_REASON)) {
            return record;
          }
          upsertStep(record, {
            step: "reconcile:abandoned",
            status: "failed",
            endedAtMs: Date.now(),
            detail: rule,
          });
          finishUpdateRunRecord(record, {
            status: "failed",
            reason: rule === LEGACY_UPDATE_RUN_EXPIRED_REASON ? rule : "abandoned",
          });
          const saved = persistRun(db, record, options);
          reconciled.push(saved);
          return saved;
        }),
        reconciled,
      };
      assertCurrent("commit");
      return result;
    },
    options,
    { schemaSql: schema, operationLabel: "update.run", busyTimeoutMs: options.busyTimeoutMs },
  );
}
