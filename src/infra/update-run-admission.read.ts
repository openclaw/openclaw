import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { EngineConnection } from "./sql-connection.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";
import type { UpdateRunAdmissionReadCommand } from "./update-run-admission.types.js";
import { readUpdateRunRecord } from "./update-run-read.kernel.js";
import {
  inspectUpdateRunReconciliation,
  readUpdateRunReconciliationCandidates,
} from "./update-run-reconciliation.read.js";
import { readUpdateRecoveryAdmissionFacts } from "./update-run-recovery-store.js";

export function readUpdateRunAdmissionCommand(
  db: EngineConnection,
  command: UpdateRunAdmissionReadCommand,
) {
  if (command.type === "updateRuns.reconciliationCandidates") {
    return {
      type: command.type,
      candidates: readUpdateRunReconciliationCandidates(db, command.input),
    };
  }
  return runSqliteReadSnapshotSync(db, () => {
    if (command.type === "updateRuns.recoveryAdmission") {
      return { type: command.type, facts: readUpdateRecoveryAdmissionFacts(db) };
    }
    const run = tableExists(db, "update_runs") ? readUpdateRunRecord(db, command.runId) : undefined;
    return {
      type: command.type,
      candidate: run ? inspectUpdateRunReconciliation(db, run, {}) : undefined,
    };
  });
}
