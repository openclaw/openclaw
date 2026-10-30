import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  getSqliteDatabaseAdmission,
  prepareSqliteDatabaseAdmissionForPath,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  AgentDeletionJournalDisposition,
  AgentDeletionJournalStatus,
  RetainedAgentDeletion,
} from "./agent-deletion-journal.types.js";

type PreparedDeletionDiscovery = Exclude<
  AgentDeletionJournalDisposition,
  { status: "unavailable" }
>;

const discoveryKey: SqliteDatabaseAdmissionKey<PreparedDeletionDiscovery | null> = {
  name: "agent.deletion-discovery",
  schemaDependent: true,
  // SAFETY: These typed owner facts only cross the paired database admission transport.
  read: (value) => (isRecord(value) ? (value as PreparedDeletionDiscovery) : undefined),
};

export function getAgentDeletionDiscovery(database: EngineConnection) {
  return getSqliteDatabaseAdmission(database, discoveryKey) ?? undefined;
}

export function getPreparedAgentDeletionDiscovery(statePath: string) {
  return (
    getOrLoadSqliteDatabaseAdmissionForPath(statePath, discoveryKey, () => undefined) ?? undefined
  );
}

/** A slow read reply cannot replace a newer journal commit. */
export function seedAgentDeletionDiscovery(
  statePath: string,
  disposition: AgentDeletionJournalDisposition,
): void {
  if (disposition.status !== "unavailable") {
    getOrLoadSqliteDatabaseAdmissionForPath(statePath, discoveryKey, () => disposition);
  }
}

/** Journal writers update the prepared discovery fact in their own transaction. */
export function updateAgentDeletionDiscovery(
  database: EngineConnection,
  current: AgentDeletionJournalDisposition,
  agentId: string,
  update: (entry: RetainedAgentDeletion | undefined) => RetainedAgentDeletion | undefined,
): void {
  if (current.status === "unavailable") {
    publishSqliteDatabaseAdmission(database, discoveryKey, null);
    return;
  }
  const known = current.status === "present" ? current : undefined;
  const entries = (known?.entries ?? []).filter((entry) => entry.agentId !== agentId);
  const updated = update(known?.entries.find((entry) => entry.agentId === agentId));
  if (updated) {
    entries.push(updated);
    entries.sort((a, b) => a.agentId.localeCompare(b.agentId));
  }
  const held = known?.held ?? [];
  publishSqliteDatabaseAdmission(
    database,
    discoveryKey,
    entries.length || held.length ? { status: "present", entries, held } : { status: "empty" },
  );
}

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
  database: EngineConnection,
  agentId: string,
  status: AgentDeletionJournalStatus,
): void {
  publishSqliteDatabaseAdmission(database, statusKey(agentId), status);
}

/** Offline repairs and raw fixture mutations discard only the affected agent's fact. */
export function invalidateAgentDeletionJournalStatus(
  database: EngineConnection,
  agentId: string,
): void {
  publishSqliteDatabaseAdmission(database, statusKey(agentId), null);
  publishSqliteDatabaseAdmission(database, discoveryKey, null);
}

export function getAgentDeletionJournalStatus(
  database: EngineConnection,
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

/** Keep the prepared key; the admission owner checks the live fact's revision on every effect. */
export function prepareAgentDeletionJournalStatus(statePath: string, agentId: string) {
  const key = statusKey(agentId);
  const readCommitted = prepareSqliteDatabaseAdmissionForPath(statePath, key);
  return (database?: EngineConnection): AgentDeletionJournalStatus | undefined =>
    (database ? getSqliteDatabaseAdmission(database, key) : readCommitted()) ?? undefined;
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
