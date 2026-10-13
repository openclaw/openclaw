import type { DatabaseSync } from "node:sqlite";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { AgentDeletionJournalStatus } from "./agent-deletion-journal.types.js";

function statusKey(agentId: string): SqliteDatabaseAdmissionKey<AgentDeletionJournalStatus | null> {
  return {
    name: `agent.deletion-status:${normalizeAgentId(agentId)}`,
    schemaDependent: true,
    read: (value) =>
      value === "absent" || value === "pending" || value === "complete" ? value : undefined,
  };
}

/** The journal writer publishes after commit through the existing database-fact transport. */
export function publishAgentDeletionJournalStatus(
  database: DatabaseSync,
  agentId: string,
  status: AgentDeletionJournalStatus,
): void {
  publishSqliteDatabaseAdmission(database, statusKey(agentId), status);
}

/** Offline repairs and raw fixture mutations discard only the affected agent's fact. */
export function invalidateAgentDeletionJournalStatus(
  database: DatabaseSync,
  agentId: string,
): void {
  publishSqliteDatabaseAdmission(database, statusKey(agentId), null);
}

export function getAgentDeletionJournalStatus(
  database: DatabaseSync,
  agentId: string,
): AgentDeletionJournalStatus | undefined {
  return getSqliteDatabaseAdmission(database, statusKey(agentId)) ?? undefined;
}

/** Synchronous guards consume the same committed fact as asynchronous turn admission. */
export function getOrLoadAgentDeletionJournalStatus(
  statePath: string,
  agentId: string,
  load: () => AgentDeletionJournalStatus | undefined,
): AgentDeletionJournalStatus | undefined {
  return getOrLoadSqliteDatabaseAdmissionForPath(statePath, statusKey(agentId), load) ?? undefined;
}

const pendingLoads = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDeletionJournalStatusLoads"),
  () => new Map<string, Promise<AgentDeletionJournalStatus>>(),
);

/** First admission loads once; journal writes replace the shared fact before observers run. */
export async function loadAgentDeletionJournalStatus(
  statePath: string,
  agentId: string,
  load: () => Promise<AgentDeletionJournalStatus>,
): Promise<AgentDeletionJournalStatus> {
  const key = statusKey(agentId);
  const cached = getOrLoadAgentDeletionJournalStatus(statePath, agentId, () => undefined);
  if (cached) {
    return cached;
  }
  const pendingKey = JSON.stringify([statePath, key.name]);
  let pending = pendingLoads.get(pendingKey);
  if (!pending) {
    pending = (async () => {
      const loaded = await load();
      // A deletion committed during the read owns the newer fact.
      return getOrLoadAgentDeletionJournalStatus(statePath, agentId, () => loaded) ?? loaded;
    })();
    pendingLoads.set(pendingKey, pending);
  }
  try {
    return await pending;
  } finally {
    if (pendingLoads.get(pendingKey) === pending) {
      pendingLoads.delete(pendingKey);
    }
  }
}
