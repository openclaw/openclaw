import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { SessionEntryLifecycleUpsertConflictError } from "./session-accessor.lifecycle-types.js";
import type { MaterializedSessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteLegacySessionEntryRows,
  deleteSessionEntryRows,
  readExactSessionEntryJson,
  readExactSessionEntryRow,
  readSessionEntryCount,
  rehomeSessionWindows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  deleteMaterializedSessionStatePlans,
  shouldRemoveSessionEntry,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ProjectedLifecycleMutation,
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenanceInDatabase,
  emptySessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-maintenance-store.js";
import { appendSessionResetBoundary } from "./session-accessor.sqlite-reset-boundary.js";
import type { ResolvedSqliteReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

export type ProjectedLifecycleCommitResult = {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
  beforeCount: number;
  maintenancePlans: SessionEntryMaintenancePlan[];
  removedSessionKeys: string[];
  pendingArchives: boolean;
};

export type ProjectedLifecycleRemovalCommitInput = {
  projected: ProjectedLifecycleMutation;
  materializationFailed: boolean;
  allowCanonicalRepair?: boolean;
  maintenance: SessionEntryMaintenanceInput | null;
};

type ProjectedLifecycleCommitOptions = Omit<ProjectedLifecycleRemovalCommitInput, "maintenance"> & {
  removalPlans: MaterializedSessionStateDeletePlan[];
  resetScope: ResolvedSqliteReadScope;
  applyMaintenance: (database: OpenClawAgentDatabase) => SessionEntryMaintenancePlan;
  afterUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  afterFreshUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
};

function readProjectedRemovalEntry(
  database: OpenClawAgentDatabase,
  projected: ProjectedLifecycleMutation["removals"][number],
  allowCanonicalRepair = false,
): SessionEntry | undefined {
  const expectedRawEntryJson = projected.removal.expectedRawEntryJson;
  if (expectedRawEntryJson === undefined) {
    return (
      allowCanonicalRepair
        ? readExactSessionEntryRowForCanonicalRepair(database, projected.sessionKey, {
            allowMalformedRowRepair: true,
          })
        : readExactSessionEntryRow(database, projected.sessionKey)
    )?.entry;
  }
  if (readExactSessionEntryJson(database, projected.sessionKey) !== expectedRawEntryJson) {
    throw new Error(
      `SQLite session entry changed before raw lifecycle removal for ${projected.sessionKey}`,
    );
  }
  return projected.expectedEntry;
}

/** The native and worker paths execute the same exact-row batch in their admitted transaction. */
export function commitProjectedSessionEntryLifecycleMutationInDatabase(
  database: OpenClawAgentDatabase,
  options: ProjectedLifecycleCommitOptions,
): ProjectedLifecycleCommitResult {
  const { projected, removalPlans, materializationFailed } = options;
  let pendingArchives = true;
  const removedSessionKeys: string[] = [];
  if (
    projected.archiveRecovery?.databaseIdentity ===
    readOpenClawAgentDatabaseIdentity(database).identity
  ) {
    pendingArchives = projected.archiveRecovery.pending;
  }
  const beforeCount = readSessionEntryCount(database);
  const validatedRemovals = projected.removals.filter((removal) => {
    if (materializationFailed && removal.removal.archiveRemovedTranscript === true) {
      return false;
    }
    const entry = readProjectedRemovalEntry(database, removal, options.allowCanonicalRepair);
    if (!sqliteSessionEntriesEqual(entry, removal.expectedEntry)) {
      const replacedInSameMutation = projected.upsertedEntries.some(
        (upsert) => upsert.sessionKey === removal.sessionKey,
      );
      throw new Error(
        replacedInSameMutation
          ? `SQLite session entry has stale lifecycle state for ${removal.sessionKey}`
          : `SQLite session entry changed before lifecycle removal for ${removal.sessionKey}`,
      );
    }
    const shouldRemove = shouldRemoveSessionEntry(entry, removal.removal);
    if (
      !shouldRemove &&
      projected.upsertedEntries.some((upsert) => upsert.sessionKey === removal.sessionKey)
    ) {
      throw new Error(`SQLite session entry has stale lifecycle state for ${removal.sessionKey}`);
    }
    return shouldRemove;
  });
  const archivedTranscripts = deleteMaterializedSessionStatePlans(
    database,
    removalPlans,
    undefined,
    new Set(validatedRemovals.map((removal) => removal.sessionKey)),
  );
  const legacyReplacementTargets = new Map<
    string,
    { canonicalKey: string; rehomeMembers: boolean }
  >();
  for (const {
    sessionKey,
    entry,
    expectedEntry,
    routeContext,
    resetBoundary,
  } of projected.upsertedEntries) {
    const sameKeyRemoval = validatedRemovals.find((removal) => removal.sessionKey === sessionKey);
    const currentEntry = sameKeyRemoval
      ? readProjectedRemovalEntry(database, sameKeyRemoval, options.allowCanonicalRepair)
      : (options.allowCanonicalRepair
          ? readExactSessionEntryRowForCanonicalRepair(database, sessionKey, {
              allowMalformedRowRepair: true,
            })
          : readExactSessionEntryRow(database, sessionKey)
        )?.entry;
    const expectedCurrentEntry = expectedEntry ?? sameKeyRemoval?.expectedEntry;
    if (!sqliteSessionEntriesEqual(currentEntry, expectedCurrentEntry)) {
      if (sameKeyRemoval) {
        throw new Error(`SQLite session entry has stale lifecycle state for ${sessionKey}`);
      }
      throw new SessionEntryLifecycleUpsertConflictError(sessionKey);
    }
    if (sameKeyRemoval && !shouldRemoveSessionEntry(currentEntry, sameKeyRemoval.removal)) {
      throw new Error(`SQLite session entry has stale lifecycle state for ${sessionKey}`);
    }
    if (resetBoundary && expectedEntry?.sessionId) {
      const boundaryScope = {
        ...options.resetScope,
        sessionId: expectedEntry.sessionId,
        sessionKey,
      };
      appendSessionResetBoundary(database, boundaryScope, expectedEntry, resetBoundary);
    }
    writeSessionEntry(database, sessionKey, entry, {
      allowStoredAliases: options.allowCanonicalRepair === true,
      preserveNodeSuggestions: options.allowCanonicalRepair === true,
      previousEntry: expectedCurrentEntry ?? null,
      ...(routeContext !== undefined ? { routeContext } : {}),
    });
    const relatedRemovalKeys = validatedRemovals.flatMap((removal) => {
      const removedSessionId = removal.expectedEntry.sessionId;
      return removal.sessionKey !== sessionKey &&
        (removedSessionId === entry.sessionId || removedSessionId === entry.previousSessionId)
        ? [removal.sessionKey]
        : [];
    });
    rehomeSessionWindows(database, sessionKey, relatedRemovalKeys);
    for (const legacyKey of relatedRemovalKeys) {
      const removedEntry = validatedRemovals.find(
        (removal) => removal.sessionKey === legacyKey,
      )?.expectedEntry;
      legacyReplacementTargets.set(legacyKey, {
        canonicalKey: sessionKey,
        rehomeMembers: removedEntry?.sessionId === entry.sessionId,
      });
    }
  }
  options.afterUpsertsInTransaction?.(database);
  options.afterFreshUpsertsInTransaction?.(database);
  const upsertedKeys = new Set(projected.upsertedEntries.map((upsert) => upsert.sessionKey));
  for (const removal of validatedRemovals) {
    if (upsertedKeys.has(removal.sessionKey)) {
      continue;
    }
    const entry = readProjectedRemovalEntry(database, removal, options.allowCanonicalRepair);
    if (!sqliteSessionEntriesEqual(entry, removal.expectedEntry)) {
      throw new Error(
        `SQLite session entry changed before lifecycle removal for ${removal.sessionKey}`,
      );
    }
    if (!shouldRemoveSessionEntry(entry, removal.removal)) {
      continue;
    }
    const replacement = legacyReplacementTargets.get(removal.sessionKey);
    if (replacement) {
      deleteLegacySessionEntryRows(database, [removal.sessionKey], replacement.canonicalKey, {
        rehomeMembers: replacement.rehomeMembers,
        validatedEntries: new Map([[removal.sessionKey, entry]]),
      });
    } else {
      deleteSessionEntryRows(database, removal.sessionKey, {
        deleteOwnedWindows: removal.removal.deleteOwnedWindows === true,
        deliveryCleanupKeys: removal.removal.deliveryCleanupKeys,
        validatedEntry: entry,
      });
    }
    removedSessionKeys.push(removal.sessionKey);
  }
  return {
    archivedTranscripts,
    beforeCount,
    maintenancePlans: [options.applyMaintenance(database)],
    removedSessionKeys,
    pendingArchives,
  };
}

/** Adapt cloneable removal inputs to the shared transaction kernel. */
export function commitProjectedSessionEntryRemovalsInDatabase(
  database: OpenClawAgentDatabase,
  input: ProjectedLifecycleRemovalCommitInput,
  removalPlans: MaterializedSessionStateDeletePlan[],
): ProjectedLifecycleCommitResult {
  if (input.projected.upsertedEntries.length > 0) {
    throw new Error("Worker lifecycle removal cannot contain upserts");
  }
  return commitProjectedSessionEntryLifecycleMutationInDatabase(database, {
    ...input,
    removalPlans,
    resetScope: { agentId: database.agentId },
    applyMaintenance: (current) => {
      const maintenance = input.maintenance;
      if (!maintenance) {
        return emptySessionEntryMaintenancePlan();
      }
      const preservation = maintenance.preservation;
      if (!preservation) {
        throw new Error("Worker lifecycle removal requires maintenance preservation");
      }
      return applySessionEntryMaintenanceInDatabase(current, maintenance, () => preservation);
    },
  });
}
