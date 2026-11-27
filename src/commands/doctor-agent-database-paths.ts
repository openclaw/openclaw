import { note } from "../../packages/terminal-core/src/note.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  planOpenClawAgentDatabasePathRepairs,
  repairOpenClawAgentDatabasePaths,
} from "../state/openclaw-agent-db-path-repair.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { isUpdateDoctorLintPass } from "./doctor/shared/update-phase.js";

/** Repair the inventory only before an updater captures its exact-path baseline. */
export function noteDoctorAgentDatabasePathHealth(params: {
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): string[] {
  if (!params.shouldRepair || !agentDatabasePathRepairsMayExist(params.env)) {
    return [];
  }
  const report = runOpenClawStateWriteTransaction(
    (database) => repairOpenClawAgentDatabasePaths(database, isUpdateDoctorLintPass(params.env)),
    { env: params.env },
    { operationLabel: "doctor.agent-database-paths" },
  );
  if (report.repaired > 0) {
    invalidateRegisteredAgentDatabasesMemo({ env: params.env });
    note(`Repaired ${report.repaired} agent database path registration(s).`, "Doctor changes");
  }
  if (report.warnings.length > 0) {
    note(report.warnings.join("\n"), "Doctor warnings");
  }
  return report.warnings;
}

/**
 * Read-only: the registrations the repair would change, read directly from the existing state
 * database (no copy, no write admission). Zero without a database.
 */
function countOpenClawAgentDatabasePathRepairs(env: NodeJS.ProcessEnv): number {
  return (
    withExistingOpenClawStateDatabaseCurrentReadOnly(
      ({ db, path }) =>
        planOpenClawAgentDatabasePathRepairs(
          path,
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "agent_databases">>(db)
              .selectFrom("agent_databases")
              .selectAll()
              .orderBy("last_seen_at", "desc")
              .orderBy("path"),
          ).rows,
        ).pending,
      { env, allowNativeRead: true },
    ) ?? 0
  );
}

/** Read first: a clean registry needs no write transaction on the shared state database. */
function agentDatabasePathRepairsMayExist(env: NodeJS.ProcessEnv): boolean {
  try {
    return countOpenClawAgentDatabasePathRepairs(env) > 0;
  } catch {
    // The write transaction reports an unreadable registry.
    return true;
  }
}
