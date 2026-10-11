import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import type { ProcessAgentDatabaseLease } from "./openclaw-agent-db-contract.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { DB } from "./openclaw-state-db.generated.js";

/** Rows owned by one process incarnation; an unknown start time on either side matches by pid. */
export function readProcessAgentDatabaseLeasesInDatabase(
  database: DatabaseSync,
  ownerPid: number,
  ownerStartTime: number | null,
): ProcessAgentDatabaseLease[] {
  const rows = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "agent_database_leases">>(database)
      .selectFrom("agent_database_leases")
      .select(["lease_id", "agent_id", "opened_at", "owner_start_time"])
      .where("owner_pid", "=", ownerPid)
      .orderBy("opened_at", "asc"),
  ).rows;
  return rows
    .filter(
      (row) =>
        ownerStartTime === null ||
        row.owner_start_time === null ||
        row.owner_start_time === ownerStartTime,
    )
    .map((row) => ({ leaseId: row.lease_id, agentId: row.agent_id, openedAt: row.opened_at }));
}

/**
 * Lists this process's agent-database lease rows through the state reader Worker. It also
 * sees leases claimed inside other Workers, which the Gateway's handle cache cannot. The
 * result is diagnostic only and grants no lease authority.
 */
export async function readProcessAgentDatabaseLeasesInWorker(
  options: OpenClawStateDatabaseOptions = {},
  signal?: AbortSignal,
): Promise<ProcessAgentDatabaseLease[]> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    {
      type: "agentDatabaseLeases.process",
      ownerPid: process.pid,
      ownerStartTime: getFileLockProcessStartTime(process.pid),
    },
    { current: true, signal },
  );
  if (reply && (!reply.ok || reply.type !== "agentDatabaseLeases.process")) {
    throw new Error("Unexpected agent database lease read result");
  }
  return reply?.leases ?? [];
}
