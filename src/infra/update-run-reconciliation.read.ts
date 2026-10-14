import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { inspectUpdateRunAbandonment } from "./update-run-activity.js";
import { decodeRun, hasStoredUpdateRecovery } from "./update-run-read.kernel.js";
import type {
  UpdateRunReconciliationCandidate,
  UpdateRunReconciliationInput,
} from "./update-run-reconciliation.types.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "./update-run-timeouts.js";

type LedgerDatabase = Pick<DB, "update_runs">;

// The standalone state reader bundles dynamic imports too; keep write-side dependencies out.
export function inspectUpdateRunReconciliation(
  db: DatabaseSync,
  record: UpdateRunRecord,
  input: UpdateRunReconciliationInput,
): UpdateRunReconciliationCandidate {
  return {
    record,
    rule: hasStoredUpdateRecovery(db, record.runId)
      ? undefined
      : inspectUpdateRunAbandonment(record, input),
  };
}

export function readUpdateRunReconciliationCandidates(
  db: DatabaseSync,
  input: UpdateRunReconciliationInput,
): UpdateRunReconciliationCandidate[] {
  if (!tableExists(db, "update_runs")) {
    return [];
  }
  let query = getNodeSqliteKysely<LedgerDatabase>(db)
    .selectFrom("update_runs")
    .selectAll()
    .where("status", "=", "running");
  if (!input.explicit) {
    query = query.where("updated_at_ms", "<", Date.now() - ABANDONED_UPDATE_RUN_MS);
  }
  if (input.runIds) {
    query = query.where("run_id", "in", [...input.runIds]);
  }
  return executeSqliteQuerySync(db, query.orderBy("run_id")).rows.map((row) =>
    inspectUpdateRunReconciliation(db, decodeRun(row), input),
  );
}
