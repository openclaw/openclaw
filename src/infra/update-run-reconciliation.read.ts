import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { readRestartSentinelRowSync } from "./restart-sentinel-store.js";
import type { EngineConnection } from "./sql-connection.js";
import { inspectUpdateRunAbandonment } from "./update-run-activity.js";
import { decodeRun, hasStoredUpdateRecovery } from "./update-run-read.kernel.js";
import type {
  UpdateRunReconciliationCandidate,
  UpdateRunReconciliationInput,
} from "./update-run-reconciliation.types.js";
import type { UpdateRunRecord } from "./update-run-record.js";

type LedgerDatabase = Pick<DB, "update_runs">;

// The standalone state reader bundles dynamic imports too; keep write-side dependencies out.
export function inspectUpdateRunReconciliation(
  db: EngineConnection,
  record: UpdateRunRecord,
  input: UpdateRunReconciliationInput,
): UpdateRunReconciliationCandidate {
  const rule = hasStoredUpdateRecovery(db, record.runId)
    ? undefined
    : inspectUpdateRunAbandonment(record, input);
  if (
    rule &&
    !input.explicit &&
    record.trigger !== "cli" &&
    (record.phase === "restarting" || record.phase === "verifying") &&
    tableExists(db, "gateway_restart_sentinel")
  ) {
    const sentinel = readRestartSentinelRowSync(db);
    const payload = sentinel.kind === "valid" ? sentinel.sentinel.payload : undefined;
    if (
      payload?.kind === "update" &&
      payload.status === "ok" &&
      payload.stats?.runId === record.runId &&
      !payload.stats.handoffId
    ) {
      // The foreground updater exits before its replacement Gateway verifies this handoff.
      return { record, rule: undefined };
    }
  }
  return { record, rule };
}

export function readUpdateRunReconciliationCandidates(
  db: EngineConnection,
  input: UpdateRunReconciliationInput,
): UpdateRunReconciliationCandidate[] {
  if (!tableExists(db, "update_runs")) {
    return [];
  }
  let query = getNodeSqliteKysely<LedgerDatabase>(db)
    .selectFrom("update_runs")
    .selectAll()
    .where("status", "=", "running");
  if (input.runIds) {
    query = query.where("run_id", "in", [...input.runIds]);
  }
  if (input.excludeRunId) {
    query = query.where("run_id", "!=", input.excludeRunId);
  }
  return executeSqliteQuerySync(db, query.orderBy("run_id")).rows.map((row) =>
    inspectUpdateRunReconciliation(db, decodeRun(row), input),
  );
}
