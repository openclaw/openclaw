import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta-readonly.js";
import { isSubagentSessionFromEntry } from "../agents/subagents/spawn/subagent-depth-policy.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import type { CurrentTranscriptProjection } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { PreparedSessionHistoryReadTarget } from "./session-history-read.types.js";
import { readGatewaySessionEntryFromSources } from "./session-utils-store-readonly.js";
import type { GatewaySessionStoreReadSources } from "./session-utils-store.types.js";

type SessionHistorySubagentSource = Pick<CurrentTranscriptProjection, "database"> & {
  resolved: Pick<CurrentTranscriptProjection["resolved"], "agentId">;
};

/** Source lineage is independent of which live or archived transcript is being displayed. */
export function createBoundSessionHistorySubagentSource(
  readSnapshot: <T>(read: (source: SessionHistorySubagentSource) => T) => T,
  stateDatabase: PreparedSessionHistoryReadTarget["stateDatabase"],
  readSourceDatabases: () => GatewaySessionStoreReadSources | undefined,
  sources: {
    get: (key: string) => boolean | undefined;
    set: (key: string, value: boolean) => unknown;
  } = new Map(),
): (sessionKey: string) => boolean {
  const readSource = (projection: SessionHistorySubagentSource, sessionKey: string) => {
    const cached = sources.get(sessionKey);
    if (cached !== undefined) {
      return cached;
    }
    if (isSubagentSessionFromEntry(sessionKey, undefined)) {
      sources.set(sessionKey, true);
      return true;
    }
    // Retired native children retain their canonical key. ACP lineage additionally
    // requires current metadata from its separately bound shared-state owner.
    const sourceAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    const sourceDatabases = readSourceDatabases();
    const ownSource = { agentId: projection.database.agentId, path: projection.database.path };
    const hasPreparedSource = Boolean(
      sourceAgentId && sourceDatabases && Object.hasOwn(sourceDatabases, sourceAgentId),
    );
    const candidates =
      sourceAgentId && sourceDatabases && hasPreparedSource
        ? [...(sourceDatabases[sourceAgentId] ?? [])]
        : [];
    if (!sourceAgentId || sourceAgentId === projection.resolved.agentId || !hasPreparedSource) {
      if (
        !candidates.some(
          (source) => source.agentId === ownSource.agentId && source.path === ownSource.path,
        )
      ) {
        candidates.unshift(ownSource);
      }
    }
    const ownCandidate = candidates.find(
      (source) => source.agentId === ownSource.agentId && source.path === ownSource.path,
    );
    const ownEntry = ownCandidate
      ? readExactSessionEntryRow(projection.database, sessionKey, "list")?.entry
      : undefined;
    const entry = readGatewaySessionEntryFromSources(sessionKey, candidates, {
      source: ownCandidate ?? ownSource,
      entry: ownEntry,
    });
    let child = isSubagentSessionFromEntry(sessionKey, entry);
    if (!child && entry && (entry.parentSessionKey || entry.spawnedBy) && stateDatabase) {
      const acp = withStateDatabaseCoordinatorRuntimeDirectory(
        stateDatabase.coordinatorRuntime,
        () =>
          readAcpSessionMetaForEntry({
            sessionKey,
            agentId: parseAgentSessionKey(sessionKey)?.agentId,
            entry,
            databasePath: stateDatabase.path,
            env: stateDatabase.environment,
          }),
      );
      child = isSubagentSessionFromEntry(sessionKey, entry, acp);
    }
    sources.set(sessionKey, child);
    return child;
  };
  return (sessionKey) =>
    sources.get(sessionKey) ?? readSnapshot((projection) => readSource(projection, sessionKey));
}
