import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { MaterializedSessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import { captureSessionEntrySnapshot } from "./session-accessor.sqlite-entry-snapshot.js";
import {
  deleteLegacySessionEntryRows,
  deleteSessionEntryRows,
  readExactSessionEntryRow,
  readSessionEntryCount,
  rehomeSessionWindows,
  writeSessionEntry,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-store.js";
import {
  assertRawSessionEntryRemovalUnchanged,
  deleteMaterializedSessionStatePlans,
  shouldRemoveSessionEntry,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ProjectedLifecycleCommitResult,
  ProjectedLifecycleCommitInput,
  ProjectedLifecycleMutation,
  SessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenanceInDatabase,
  emptySessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-maintenance-store.js";
import { appendSessionResetBoundary } from "./session-accessor.sqlite-reset-boundary.js";
import type { ResolvedSqliteReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import { SessionEntryLifecycleUpsertConflictError } from "./session-mutation-conflict-error.js";
import type { SessionEntry } from "./types.js";

type ProjectedLifecycleCommitOptions = Omit<ProjectedLifecycleCommitInput, "maintenance"> & {
  removalPlans: MaterializedSessionStateDeletePlan[];
  resetScope: ResolvedSqliteReadScope;
  applyMaintenance: (
    database: OpenClawAgentDatabase,
    postimages?: SessionEntryWritePostimages,
  ) => SessionEntryMaintenancePlan;
  postimages?: SessionEntryWritePostimages;
  onArchived?: (sessionKey: string, previous: SessionEntry, current: SessionEntry) => void;
  onResetBoundary?: (facts: {
    sessionKey: string;
    sessionId: string;
    progressCardReset: boolean;
    projectionNeedsReconcile: boolean;
  }) => void;
  afterUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  afterFreshUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
};

function readProjectedRemovalEntry(
  database: OpenClawAgentDatabase,
  projected: ProjectedLifecycleMutation["removals"][number],
  allowCanonicalRepair = false,
): { entry: SessionEntry; row?: ResolvedSessionEntryRow["row"] } | undefined {
  if (projected.removal.expectedRawEntryJson === undefined) {
    return allowCanonicalRepair
      ? readExactSessionEntryRowForCanonicalRepair(database, projected.sessionKey, {
          allowMalformedRowRepair: true,
        })
      : readExactSessionEntryRow(database, projected.sessionKey, "full", undefined, true);
  }
  assertRawSessionEntryRemovalUnchanged(database, projected.sessionKey, projected.removal);
  return { entry: projected.expectedEntry };
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
  const validatedRemovalEntries = new Map<string, SessionEntry>();
  const validatedRemovalRows = new Map<string, ReturnType<typeof readProjectedRemovalEntry>>();
  const validatedRemovals = projected.removals.filter((removal) => {
    if (materializationFailed && removal.removal.archiveRemovedTranscript === true) {
      return false;
    }
    const selected = readProjectedRemovalEntry(database, removal, options.allowCanonicalRepair);
    const entry = selected?.entry;
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
    if (shouldRemove && entry) {
      validatedRemovalEntries.set(removal.sessionKey, entry);
      validatedRemovalRows.set(removal.sessionKey, selected);
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
    const currentRow = sameKeyRemoval
      ? validatedRemovalRows.get(sessionKey)
      : options.allowCanonicalRepair
        ? readExactSessionEntryRowForCanonicalRepair(database, sessionKey, {
            allowMalformedRowRepair: true,
          })
        : readExactSessionEntryRow(database, sessionKey, "full", undefined, true);
    const currentEntry = sameKeyRemoval
      ? validatedRemovalEntries.get(sessionKey)
      : currentRow?.entry;
    const currentFacts = currentRow?.row
      ? captureSessionEntrySnapshot({ entry: currentRow.entry, row: currentRow.row })
      : undefined;
    const expectedCurrentEntry = expectedEntry ?? sameKeyRemoval?.expectedEntry;
    if (!sqliteSessionEntriesEqual(currentEntry, expectedCurrentEntry)) {
      if (sameKeyRemoval) {
        throw new Error(`SQLite session entry has stale lifecycle state for ${sessionKey}`);
      }
      throw new SessionEntryLifecycleUpsertConflictError(sessionKey);
    }
    if (resetBoundary && expectedEntry?.sessionId) {
      const boundaryScope = {
        ...options.resetScope,
        sessionId: expectedEntry.sessionId,
        sessionKey,
      };
      let projectionNeedsReconcile = false;
      const progressCardReset = appendSessionResetBoundary(
        database,
        boundaryScope,
        expectedEntry,
        resetBoundary,
        options.onResetBoundary
          ? {
              scheduleProjectionReconcile: false,
              onProjectionReconcileNeeded: () => {
                projectionNeedsReconcile = true;
              },
            }
          : undefined,
      );
      options.onResetBoundary?.({
        sessionKey,
        sessionId: expectedEntry.sessionId,
        progressCardReset,
        projectionNeedsReconcile,
      });
    }
    writeSessionEntry(database, sessionKey, entry, {
      allowStoredAliases: options.allowCanonicalRepair === true,
      preserveNodeSuggestions: options.allowCanonicalRepair === true,
      previousEntry: expectedCurrentEntry ?? null,
      // Reset appends can change entry metadata after the authoritative read above.
      ...(!resetBoundary
        ? {
            canonicalPreviousEntry: currentEntry ?? null,
            canonicalPreviousRow: currentRow?.row,
            canonicalPreviousWindow: currentFacts?.window,
            canonicalPreviousSideTables: currentFacts?.sideTables,
          }
        : {}),
      postimages: options.postimages,
      ...(routeContext !== undefined ? { routeContext } : {}),
    });
    const relatedRemovalKeys = validatedRemovals.flatMap((removal) => {
      const removedSessionId = removal.expectedEntry.sessionId;
      return removal.sessionKey !== sessionKey &&
        (removedSessionId === entry.sessionId || removedSessionId === entry.previousSessionId)
        ? [removal.sessionKey]
        : [];
    });
    rehomeSessionWindows(database, sessionKey, relatedRemovalKeys, options.postimages);
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
    const entry = validatedRemovalEntries.get(removal.sessionKey);
    const replacement = legacyReplacementTargets.get(removal.sessionKey);
    if (replacement) {
      deleteLegacySessionEntryRows(database, [removal.sessionKey], replacement.canonicalKey, {
        rehomeMembers: replacement.rehomeMembers,
        validatedEntries: validatedRemovalEntries,
        postimages: options.postimages,
      });
    } else {
      deleteSessionEntryRows(database, removal.sessionKey, {
        deleteOwnedWindows: removal.removal.deleteOwnedWindows === true,
        deliveryCleanupKeys: removal.removal.deliveryCleanupKeys,
        validatedEntry: entry,
        postimages: options.postimages,
      });
    }
    removedSessionKeys.push(removal.sessionKey);
  }
  return {
    archivedTranscripts,
    beforeCount,
    maintenancePlans: [options.applyMaintenance(database, options.postimages)],
    removedSessionKeys,
    pendingArchives,
  };
}

/** Adapt prepared lifecycle inputs to the shared transaction kernel. */
export function commitPreparedSessionEntryLifecycleMutationInDatabase(
  database: OpenClawAgentDatabase,
  input: ProjectedLifecycleCommitInput,
  removalPlans: MaterializedSessionStateDeletePlan[],
  options?: Pick<
    ProjectedLifecycleCommitOptions,
    "resetScope" | "onResetBoundary" | "onArchived" | "postimages"
  >,
): ProjectedLifecycleCommitResult {
  return commitProjectedSessionEntryLifecycleMutationInDatabase(database, {
    ...input,
    removalPlans,
    resetScope: options?.resetScope ?? { agentId: database.agentId },
    onResetBoundary: options?.onResetBoundary,
    postimages: options?.postimages,
    onArchived: options?.onArchived,
    applyMaintenance: (current, postimages) => {
      const maintenance = input.maintenance;
      if (!maintenance) {
        return emptySessionEntryMaintenancePlan();
      }
      const preservation = maintenance.preservation;
      if (!preservation) {
        throw new Error("Worker lifecycle mutation requires maintenance preservation");
      }
      return applySessionEntryMaintenanceInDatabase(
        current,
        maintenance,
        () => preservation,
        options?.onArchived,
        undefined,
        postimages,
      );
    },
  });
}
