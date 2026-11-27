import type { EngineConnection } from "./sql-connection.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";
import type { UpdateRunAdmissionReadCommand } from "./update-run-admission.types.js";

/** Load only the selected policy before admission. No SQLite handle spans the module await. */
export async function prepareUpdateRunAdmissionRead(command: UpdateRunAdmissionReadCommand) {
  if (command.type === "updateRuns.recoveryAdmission") {
    const { readUpdateRecoveryAdmissionFacts } = await import("./update-run-recovery-store.js");
    return (db: EngineConnection) =>
      runSqliteReadSnapshotSync(db, () => ({
        type: command.type,
        facts: readUpdateRecoveryAdmissionFacts(db),
      }));
  }
  if (command.type === "updateRuns.pluginCohortRecovery") {
    const { readPluginCohortRecoveryInDatabase } = await import("./update-run-recovery-store.js");
    return (db: EngineConnection) =>
      runSqliteReadSnapshotSync(db, () => ({
        type: command.type,
        pair: readPluginCohortRecoveryInDatabase(db, command.runId),
      }));
  }
  const { readUpdateRunReconciliationCandidate, readUpdateRunReconciliationCandidates } =
    await import("./update-run-reconciliation.read.js");
  if (command.type === "updateRuns.reconciliationCandidates") {
    return (db: EngineConnection) => ({
      type: command.type,
      candidates: readUpdateRunReconciliationCandidates(db, command.input),
    });
  }
  return (db: EngineConnection) => ({
    type: command.type,
    candidate: readUpdateRunReconciliationCandidate(db, command.runId),
  });
}
