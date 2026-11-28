import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { readRestartSentinelRowSync } from "./restart-sentinel-store.js";
import type { EngineConnection } from "./sql-connection.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";
import { inspectUpdateRunAbandonment } from "./update-run-activity.js";
import {
  decodeRun,
  hasStoredUpdateRecovery,
  readUpdateRunRecord,
} from "./update-run-read.kernel.js";
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
  const rule =
    !input.explicit && hasStoredUpdateRecovery(db, record.runId)
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

function selectRunningUpdateRuns(db: EngineConnection, input: UpdateRunReconciliationInput) {
  let query = getNodeSqliteKysely<LedgerDatabase>(db)
    .selectFrom("update_runs")
    .where("status", "=", "running");
  if (input.runIds) {
    query = query.where("run_id", "in", [...input.runIds]);
  }
  if (input.excludeRunId) {
    query = query.where("run_id", "!=", input.excludeRunId);
  }
  return query;
}

export function readUpdateRunReconciliationCandidate(db: EngineConnection, runId: string) {
  return runSqliteReadSnapshotSync(db, () => {
    const run = tableExists(db, "update_runs") ? readUpdateRunRecord(db, runId) : undefined;
    return run ? inspectUpdateRunReconciliation(db, run, {}) : undefined;
  });
}

export function readUpdateRunReconciliationCandidates(
  db: EngineConnection,
  input: UpdateRunReconciliationInput,
): UpdateRunReconciliationCandidate[] {
  const pinned = db.isTransaction;
  if (!pinned && !tableExists(db, "update_runs")) {
    return [];
  }
  const selection = selectRunningUpdateRuns(db, input);
  if (!pinned) {
    // Broad probes can stop at the first active index entry. Preserve primary-key seeks
    // for explicit IDs even when SQLite has no planner statistics for the ledger.
    const probe = input.runIds ? selection.orderBy("run_id") : selection;
    if (!executeSqliteQueryTakeFirstSync(db, probe.select("status").limit(1))) {
      return [];
    }
  }
  // Rows or the table itself may disappear between the probe and BEGIN.
  return runSqliteReadSnapshotSync(db, () => {
    if (!tableExists(db, "update_runs")) {
      return [];
    }
    return executeSqliteQuerySync(db, selection.selectAll().orderBy("run_id")).rows.map((row) =>
      inspectUpdateRunReconciliation(db, decodeRun(row), input),
    );
  });
}
