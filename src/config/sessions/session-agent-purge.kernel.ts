import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readSessionEntryStore } from "./session-accessor.sqlite-entry-store.js";
import {
  assertPlannedLifecycleArtifactEntriesUnchanged,
  collectProjectedReferencedSessionIds,
  collectSessionStateIdsForEntry,
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
  planSessionStateAfterEntryRemoval,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type { SessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import type {
  SessionAgentPurgeCommit,
  SessionAgentPurgePlan,
  SessionAgentPurgeResult,
  SessionAgentPurgeSelection,
} from "./session-agent-purge.types.js";

function isDeletedAgentEntry(input: SessionAgentPurgeSelection, sessionKey: string): boolean {
  return (
    resolveStoredSessionOwnerAgentId({
      cfg: input.cfg,
      agentId: input.storeAgentId,
      sessionKey,
    }) === input.agentId
  );
}

export function prepareSessionAgentPurgeInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionAgentPurgeSelection,
): SessionAgentPurgePlan {
  const store = readSessionEntryStore(database);
  const remainingStore = { ...store };
  const entryRemovals = Object.entries(store).flatMap(([sessionKey, entry]) => {
    if (!isDeletedAgentEntry(input, sessionKey)) {
      return [];
    }
    delete remainingStore[sessionKey];
    return [{ expectedEntry: structuredClone(entry), sessionKey }];
  });
  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database,
    excludedSessionKeys: entryRemovals.map(({ sessionKey }) => sessionKey),
    projectedStore: remainingStore,
    candidateSessionIds: entryRemovals.flatMap(({ expectedEntry }) =>
      collectSessionStateIdsForEntry(expectedEntry),
    ),
  });
  // Agent retirement selects entry references only. Historical windows remain under retention ownership.
  const deletePlans = entryRemovals.flatMap(({ expectedEntry: entry }) =>
    planSessionStateAfterEntryRemoval({
      archiveDirectory: input.archiveDirectory,
      database,
      entry,
      reason: "deleted",
      referencedSessionIds,
    }),
  );
  return { deletePlans, entryRemovals };
}

export function commitSessionAgentPurgeInDatabase(
  database: OpenClawAgentDatabase,
  input: Pick<
    SessionAgentPurgeCommit,
    keyof SessionAgentPurgeSelection | "entryRemovals" | "materializedPlans"
  >,
  applyMaintenance: (database: OpenClawAgentDatabase) => SessionEntryMaintenancePlan,
): SessionAgentPurgeResult {
  const currentOwnedSessionKeys = Object.keys(readSessionEntryStore(database))
    .filter((sessionKey) => isDeletedAgentEntry(input, sessionKey))
    .toSorted();
  const plannedSessionKeys = input.entryRemovals.map(({ sessionKey }) => sessionKey).toSorted();
  if (JSON.stringify(currentOwnedSessionKeys) !== JSON.stringify(plannedSessionKeys)) {
    throw new Error("SQLite deleted-agent session entries changed before purge");
  }
  assertPlannedLifecycleArtifactEntriesUnchanged(database, input.entryRemovals);
  const archivedTranscripts = deleteMaterializedSessionStatePlans(
    database,
    input.materializedPlans,
    undefined,
    new Set(plannedSessionKeys),
  );
  deletePlannedLifecycleArtifactEntries(database, input.entryRemovals);
  return { archivedTranscripts, maintenancePlans: [applyMaintenance(database)] };
}
