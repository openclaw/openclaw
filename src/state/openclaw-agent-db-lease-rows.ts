import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { readBootId } from "../shared/boot-id.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";

type AgentDatabaseLeaseDatabase = Pick<OpenClawStateKyselyDatabase, "agent_database_leases">;

export type AgentDatabaseLeaseStaleReason =
  | "owner-boot-id-changed"
  | "owner-pid-dead"
  | "owner-start-time-changed";

/** Read-only observers and existing-schema maintenance may see leases written before boot identity. */
function hasAgentDatabaseLeaseBootIdColumn(database: DatabaseSync): boolean {
  return tableHasColumn(database, "agent_database_leases", "owner_boot_id");
}

export function readAgentDatabaseLease(database: DatabaseSync, leaseId: string) {
  const query = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database)
    .selectFrom("agent_database_leases")
    .select(["agent_id", "path", "owner_pid", "owner_start_time"])
    .where("lease_id", "=", leaseId);
  if (!hasAgentDatabaseLeaseBootIdColumn(database)) {
    const row = executeSqliteQueryTakeFirstSync(database, query);
    return row ? { ...row, owner_boot_id: null } : undefined;
  }
  return executeSqliteQueryTakeFirstSync(database, query.select("owner_boot_id"));
}

export function readAgentDatabaseLeases(database: DatabaseSync) {
  const query = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database)
    .selectFrom("agent_database_leases")
    .select(["agent_id", "lease_id", "owner_pid", "owner_start_time", "path"]);
  if (!hasAgentDatabaseLeaseBootIdColumn(database)) {
    return executeSqliteQuerySync(database, query).rows.map((row) =>
      Object.assign(row, { owner_boot_id: null as string | null }),
    );
  }
  return executeSqliteQuerySync(database, query.select("owner_boot_id")).rows;
}

export function agentDatabaseLeaseStaleReason(row: {
  owner_pid: number;
  owner_start_time: number | null;
  owner_boot_id: string | null;
}): AgentDatabaseLeaseStaleReason | undefined {
  // Hardened Linux hosts (Android, hidepid procfs, systemd ProtectProc=) answer
  // foreign PID probes with EPERM and hide /proc/<pid>/stat, so a PID reused
  // after reboot would otherwise look alive forever. Two known boot identities
  // that differ prove the owner's boot ended before the probe.
  const currentBootId = readBootId();
  if (row.owner_boot_id !== null && currentBootId !== null && row.owner_boot_id !== currentBootId) {
    return "owner-boot-id-changed";
  }
  if (isPidDefinitelyDead(row.owner_pid)) {
    return "owner-pid-dead";
  }
  const currentStartTime = getFileLockProcessStartTime(row.owner_pid);
  return row.owner_start_time !== null &&
    currentStartTime !== null &&
    row.owner_start_time !== currentStartTime
    ? "owner-start-time-changed"
    : undefined;
}
