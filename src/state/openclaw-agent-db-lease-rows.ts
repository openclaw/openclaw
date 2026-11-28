import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import type { AgentLeaseRowIdentity } from "./openclaw-agent-db-contract.js";
import { mayShareAgentDatabaseFile } from "./openclaw-agent-db-lease-provenance.js";
import { invalidateOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import type { DB } from "./openclaw-state-db.generated.js";

type AgentDatabaseLeaseRows = Pick<DB, "agent_database_leases">;

export function readAgentDatabaseLeases(database: EngineConnection, leaseId?: string) {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseRows>(database);
  const query = db.selectFrom("agent_database_leases").selectAll();
  return executeSqliteQuerySync(
    database,
    leaseId === undefined ? query : query.where("lease_id", "=", leaseId),
  ).rows;
}

function agentDatabaseLeasePaths(database: EngineConnection): string[] {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseRows>(database);
  return executeSqliteQuerySync(
    database,
    db.selectFrom("agent_database_leases").select("path").distinct(),
  ).rows.map((row) => row.path);
}

export function clearAgentDatabaseLeaseVerifications(
  database: EngineConnection,
  pathname: string,
): void {
  for (const held of new Set([pathname, ...agentDatabaseLeasePaths(database)])) {
    if (mayShareAgentDatabaseFile(held, pathname)) {
      invalidateOpenClawAgentDatabaseValidation(held, "a lease release without a confirmed close");
      revokeSqliteDatabaseAdmissionsForPath(held);
    }
  }
}

/** The caller owns the original shared transaction and has joined the exact native Worker exit. */
export function releaseExitedOpenClawAgentDatabaseLeaseInDatabase(
  database: EngineConnection,
  receipt: AgentLeaseRowIdentity,
  outcome: "refused-before-open" | "unknown",
  onInvalidation?: () => void,
): void {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseRows>(database);
  const row = readAgentDatabaseLeases(database, receipt.leaseId)[0];
  if (!row) {
    return;
  }
  if (
    row.agent_id !== receipt.agentId ||
    row.path !== receipt.path ||
    row.owner_pid !== receipt.ownerPid ||
    row.owner_start_time !== receipt.ownerStartTime
  ) {
    throw new Error("SQLite reclamation Worker lease cleanup receipt no longer matches");
  }
  if (outcome !== "refused-before-open") {
    onInvalidation?.();
    clearAgentDatabaseLeaseVerifications(database, receipt.path);
  }
  executeSqliteQuerySync(
    database,
    db.deleteFrom("agent_database_leases").where("lease_id", "=", receipt.leaseId),
  );
}
