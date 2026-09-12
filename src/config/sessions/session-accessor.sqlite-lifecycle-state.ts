import { toUSVString } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  isIncognitoOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { persistSessionTranscriptArchive } from "./session-accessor.sqlite-archive-store.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type {
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
} from "./session-accessor.sqlite-contract.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteSessionEntryRows,
  readExactSessionEntryJson,
  readExactSessionEntryRow,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  ProjectedLifecycleMutation,
  SessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  addRetainedWindowSessionReferences,
  collectSessionStateIdsForEntry,
} from "./session-accessor.sqlite-references.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";
import {
  parseSessionEntryJson as parseSessionEntryRow,
  sessionEntryMetadataJson,
} from "./session-accessor.sqlite-status.js";
import {
  assertSessionTranscriptHot,
  readSessionColdTranscript,
} from "./session-cold-storage-state.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import type { SessionEntry } from "./types.js";

// Transcript-state reclamation owner. Planning stays async-free; transactions revalidate before delete.

type SessionEntryRemovalExpectation = Pick<
  SessionEntryLifecycleRemoval,
  "expectedEntry" | "expectedLifecycleRevision" | "expectedUpdatedAt"
> & {
  expectedSessionId?: string | null;
};

export function shouldRemoveSessionEntry(
  entry: SessionEntry | undefined,
  removal: SessionEntryRemovalExpectation,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    removal.expectedEntry !== undefined &&
    !sqliteSessionEntriesEqual(entry, removal.expectedEntry)
  ) {
    return false;
  }
  // Null requires an entry without a physical ID; undefined leaves the ID unconstrained.
  if (
    removal.expectedSessionId !== undefined &&
    (removal.expectedSessionId === null
      ? entry.sessionId !== undefined
      : entry.sessionId !== removal.expectedSessionId)
  ) {
    return false;
  }
  if (
    removal.expectedLifecycleRevision !== undefined &&
    entry.lifecycleRevision !== removal.expectedLifecycleRevision
  ) {
    return false;
  }
  return removal.expectedUpdatedAt === undefined || entry.updatedAt === removal.expectedUpdatedAt;
}

/** Session ids protected by live node state. */
export function readReferencedSessionIds(
  database: Pick<OpenClawAgentDatabase, "db">,
  excludedSessionKeys: ReadonlySet<string> = new Set(),
  candidateSessionIds?: readonly string[],
  diskBudget?: { preserveRecentMs?: number | null },
): Set<string> {
  const db = getSessionKysely(database.db);
  // Only push down keys unchanged by Node/SQLite text conversion; retain exact membership below.
  const excludedKeys = [...excludedSessionKeys].filter(
    (key) => toUSVString(key) === key && !key.includes("\0") && !/[\uFFFE\uFFFF]/u.test(key),
  );
  const rows = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select([sessionEntryMetadataJson, "current_session_id", "session_key"])
      .$if(excludedKeys.length > 0, (query) =>
        query.where("session_key", "not in", sqliteStringSet(excludedKeys)),
      ),
  );
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.current_session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  addRetainedWindowSessionReferences(
    database,
    sessionIds,
    excludedSessionKeys,
    candidateSessionIds,
    diskBudget,
  );
  return candidateSessionIds
    ? new Set(candidateSessionIds.filter((sessionId) => sessionIds.has(sessionId)))
    : sessionIds;
}

// Projects references after a lifecycle mutation so reset/delete can archive
// before removing entry rows while still preserving shared session ids.
export function readReferencedSessionIdsAfterTargetMutation(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  nextEntry?: SessionEntry,
): Set<string> {
  const removedKeys = new Set(
    uniqueStrings([target.canonicalKey, ...target.storeKeys].map((key) => key.trim())),
  );
  const sessionIds = readReferencedSessionIds(database, removedKeys);
  if (nextEntry) {
    for (const sessionId of collectSessionStateIdsForEntry(nextEntry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

export function planSessionStateDeleteIfUnreferenced(params: {
  archiveTranscript?: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  reason?: "deleted" | "reset";
  referencedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): SessionStateDeletePlan | null {
  if (
    params.referencedSessionIds.has(params.sessionId) ||
    readSessionColdTranscript(params.database.db, params.sessionId)
  ) {
    return null;
  }
  return {
    agentId: params.database.agentId,
    archiveDirectory: params.archiveDirectory,
    archiveTranscript:
      params.archiveTranscript !== false && !isIncognitoOpenClawAgentDatabase(params.database),
    databasePath: params.database.path,
    reason: params.reason ?? "deleted",
    sessionId: params.sessionId,
    snapshot: readSessionStateDeleteSnapshot(params.database.db, params.sessionId),
  };
}

export function deleteMaterializedSessionStatePlans(
  database: OpenClawAgentDatabase,
  plans: readonly MaterializedSessionStateDeletePlan[],
  protectedSessionIds?: ReadonlySet<string>,
  excludedSessionKeys?: ReadonlySet<string>,
  /** Synchronous mutation notification; durable completion still belongs to COMMIT. */
  onDeleted?: () => void,
  diskBudget?: { preserveRecentMs?: number | null },
): SessionLifecycleArchivedTranscript[] {
  if (plans.length === 0) {
    return [];
  }
  const archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
  const referencedSessionIds = readReferencedSessionIds(
    database,
    excludedSessionKeys,
    plans.map((plan) => plan.sessionId),
    diskBudget,
  );
  for (const sessionId of protectedSessionIds ?? []) {
    referencedSessionIds.add(sessionId);
  }
  for (const plan of plans) {
    if (
      referencedSessionIds.has(plan.sessionId) ||
      readSessionColdTranscript(database.db, plan.sessionId)
    ) {
      continue;
    }
    const currentSnapshot = readSessionStateDeleteSnapshot(database.db, plan.sessionId);
    if (!sqliteSessionStateDeleteSnapshotsEqual(currentSnapshot, plan.snapshot)) {
      throw new Error(`SQLite session state changed before deletion for ${plan.sessionId}`);
    }
    if (plan.archive) {
      persistSessionTranscriptArchive(database, plan);
    }
    if (deleteSqliteSessionStateRows(database, plan.sessionId)) {
      onDeleted?.();
    }
    if (plan.snapshot.lastSeq !== null && plan.archivedTranscript) {
      archivedTranscripts.push(plan.archivedTranscript);
    }
  }
  return archivedTranscripts;
}

// Builds delete plans from the session ids owned by an entry after callers
// have projected which ids remain referenced.
export function planSessionStateAfterEntryRemoval(params: {
  archiveDirectory: string;
  archiveTranscript?: boolean;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  reason: "deleted" | "reset";
  referencedSessionIds?: ReadonlySet<string>;
}): SessionStateDeletePlan[] {
  const referencedSessionIds =
    params.referencedSessionIds ?? readReferencedSessionIds(params.database);
  return collectSessionStateIdsForEntry(params.entry).flatMap((sessionId) => {
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveTranscript,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: params.reason,
      referencedSessionIds,
      sessionId,
    });
    return plan ? [plan] : [];
  });
}

/** Ids of every persisted generation owned by the given logical session keys. */
export function readSessionGenerationIdsForKeys(
  database: OpenClawAgentDatabase,
  keys: Iterable<string>,
  options: { exactStoredKeys?: boolean } = {},
): string[] {
  const sessionKeys = [...keys].map((key) => (options.exactStoredKeys ? key : key.trim()));
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_id")
      .where("session_key", "in", sqliteStringSet(sessionKeys)),
  ).rows.map((row) => row.session_id);
}

// Projects removals and upserts before archive materialization so same-call
// upserts can keep a transcript live without producing a spurious archive.
export async function projectSessionEntryLifecycleMutation(
  databaseOptions: OpenClawAgentDatabaseOptions,
  params: {
    allowCanonicalRepair?: boolean;
    archiveDirectory: string;
    removals: readonly SessionEntryLifecycleRemoval[];
    upserts: readonly SessionEntryLifecycleUpsert[];
  },
): Promise<ProjectedLifecycleMutation> {
  return withSqliteSessionDatabase(databaseOptions, async (removalDatabase) => {
    const store = readSessionEntryStore(removalDatabase, {
      allowCanonicalRepair: params.allowCanonicalRepair === true,
      sessionKeys: [
        ...params.removals.map((removal) =>
          removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim(),
        ),
        ...params.upserts.map((upsert) => upsert.sessionKey.trim()),
      ],
    });
    const removedKeysToArchive = new Set<string>();
    const changedSessionKeys = new Set<string>();
    const projectedRemovals: ProjectedLifecycleMutation["removals"] = [];
    for (const removal of params.removals) {
      const sessionKey = removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim();
      let entry = removal.exactStoredKey || sessionKey ? store[sessionKey] : undefined;
      if (removal.expectedRawEntryJson !== undefined) {
        const currentRawEntryJson = readExactSessionEntryJson(removalDatabase, sessionKey);
        if (currentRawEntryJson !== removal.expectedRawEntryJson) {
          throw new Error(
            `SQLite session entry changed before raw lifecycle removal for ${sessionKey}`,
          );
        }
        entry = removal.expectedEntry ? cloneSessionEntry(removal.expectedEntry) : undefined;
      }
      if (!shouldRemoveSessionEntry(entry, removal)) {
        continue;
      }
      if (removal.expectedTranscriptSnapshot) {
        const sessionId = entry.sessionId;
        if (
          !sessionId ||
          !sqliteSessionStateDeleteSnapshotsEqual(
            readSessionStateDeleteSnapshot(removalDatabase.db, sessionId),
            removal.expectedTranscriptSnapshot,
          )
        ) {
          // Classification happens before the lifecycle writer lane. A stale fact
          // must become a no-op so newly live state is never archived and deleted.
          continue;
        }
      }
      projectedRemovals.push({
        // Capture each archive decision before an async builder can change its input.
        archiveTranscript: removal.archiveRemovedTranscript === true,
        expectedEntry: cloneSessionEntry(entry),
        removal,
        sessionKey,
      });
      if (removal.archiveRemovedTranscript === true) {
        removedKeysToArchive.add(sessionKey);
      }
      changedSessionKeys.add(sessionKey);
      delete store[sessionKey];
    }
    const upsertedEntries: ProjectedLifecycleMutation["upsertedEntries"] = [];
    for (const upsert of params.upserts) {
      const sessionKey = upsert.sessionKey.trim();
      if (!sessionKey) {
        continue;
      }
      if (
        upsert.requiresRemovalSessionKey &&
        !projectedRemovals.some(
          (removal) => removal.sessionKey === upsert.requiresRemovalSessionKey?.trim(),
        )
      ) {
        continue;
      }
      const expectedEntry = store[sessionKey] ? cloneSessionEntry(store[sessionKey]) : undefined;
      if (upsert.resetBoundary && !expectedEntry) {
        throw new Error(
          `Cannot append reset boundary without an existing session row: ${sessionKey}`,
        );
      }
      const entry =
        upsert.buildEntry === undefined
          ? upsert.entry
          : await upsert.buildEntry({
              currentEntry: expectedEntry ? cloneSessionEntry(expectedEntry) : undefined,
              sessionKey,
            });
      if (!entry) {
        continue;
      }
      const cloned = cloneSessionEntry(entry);
      store[sessionKey] = cloned;
      changedSessionKeys.add(sessionKey);
      upsertedEntries.push({
        expectedEntry,
        sessionKey,
        entry: cloned,
        ...(upsert.routeContext !== undefined ? { routeContext: upsert.routeContext } : {}),
        ...(upsert.resetBoundary ? { resetBoundary: upsert.resetBoundary } : {}),
      });
    }
    if (projectedRemovals.length === 0) {
      return { deletePlans: [], removals: projectedRemovals, upsertedEntries };
    }
    // Builders can close the original handle; admit the reference snapshot again.
    return withSqliteSessionDatabase(databaseOptions, (database) => {
      const referencedSessionIds = collectProjectedReferencedSessionIds({
        database,
        excludedSessionKeys: changedSessionKeys,
        projectedStore: store,
      });
      const deletePlans = projectedRemovals.flatMap(({ archiveTranscript, expectedEntry: entry }) =>
        planSessionStateAfterEntryRemoval({
          archiveDirectory: params.archiveDirectory,
          archiveTranscript,
          database,
          entry,
          reason: "deleted",
          referencedSessionIds,
        }),
      );
      const observedSnapshotsBySessionId = new Map(
        projectedRemovals.flatMap(({ expectedEntry, removal }) =>
          expectedEntry.sessionId && removal.expectedTranscriptSnapshot
            ? [[expectedEntry.sessionId, removal.expectedTranscriptSnapshot] as const]
            : [],
        ),
      );
      for (const plan of deletePlans) {
        const observedSnapshot = observedSnapshotsBySessionId.get(plan.sessionId);
        if (observedSnapshot) {
          // Keep the delete plan bound to classification, even if another process
          // changes the transcript after the initial projection comparison.
          plan.snapshot = observedSnapshot;
        }
      }
      const plannedIds = new Set(deletePlans.map((plan) => plan.sessionId));
      for (const sessionId of readSessionGenerationIdsForKeys(database, removedKeysToArchive)) {
        if (plannedIds.has(sessionId)) {
          continue;
        }
        const plan = planSessionStateDeleteIfUnreferenced({
          archiveDirectory: params.archiveDirectory,
          archiveTranscript: true,
          database,
          reason: "deleted",
          referencedSessionIds,
          sessionId,
        });
        if (plan) {
          deletePlans.push(plan);
          plannedIds.add(sessionId);
        }
      }
      return { deletePlans, removals: projectedRemovals, upsertedEntries };
    });
  });
}

// Projected deletes must preserve raw session_nodes.current_session_id references for
// remaining rows whose entry_json cannot be parsed into a SessionEntry.
export function collectProjectedReferencedSessionIds(params: {
  database: OpenClawAgentDatabase;
  excludedSessionKeys: Iterable<string>;
  projectedStore: Record<string, SessionEntry>;
}): Set<string> {
  const excludedSessionKeys = new Set(params.excludedSessionKeys);
  const sessionIds = readReferencedSessionIds(params.database, excludedSessionKeys);
  for (const entry of Object.values(params.projectedStore)) {
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

export { collectSessionStateIdsForEntry };

function deleteSqliteSessionStateRows(database: OpenClawAgentDatabase, sessionId: string): boolean {
  assertSessionTranscriptHot(database.db, sessionId);
  const db = getSessionKysely(database.db);
  // The window row cascades canonical transcript tables, but FTS is virtual;
  // clear its projection before dropping the owner row.
  deleteSessionTranscriptIndexInTransaction(database.db, sessionId);
  const deleted = executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_windows").where("session_id", "=", sessionId),
  );
  return Number(deleted.numAffectedRows ?? 0n) > 0;
}

export function deletePlannedLifecycleArtifactEntries(
  database: OpenClawAgentDatabase,
  entries: readonly SessionEntryRemovalPlan[],
): number {
  assertPlannedLifecycleArtifactEntriesUnchanged(database, entries);
  for (const planned of entries) {
    deleteSessionEntryRows(database, planned.sessionKey);
  }
  return entries.length;
}

export function assertPlannedLifecycleArtifactEntriesUnchanged(
  database: OpenClawAgentDatabase,
  entries: readonly SessionEntryRemovalPlan[],
): void {
  for (const planned of entries) {
    const current = readExactSessionEntryRow(database, planned.sessionKey)?.entry;
    if (!sqliteSessionEntriesEqual(current, planned.expectedEntry)) {
      throw new Error(`SQLite lifecycle cleanup entry changed for ${planned.sessionKey}`);
    }
  }
}

/** Partition only optimistic entry conflicts; database and parse failures stay fatal. */
export function partitionUnchangedPlannedLifecycleArtifactEntries(
  database: OpenClawAgentDatabase,
  entries: readonly SessionEntryRemovalPlan[],
): { changed: SessionEntryRemovalPlan[]; unchanged: SessionEntryRemovalPlan[] } {
  const changed: SessionEntryRemovalPlan[] = [];
  const unchanged: SessionEntryRemovalPlan[] = [];
  for (const planned of entries) {
    const current = readExactSessionEntryRow(database, planned.sessionKey)?.entry;
    (sqliteSessionEntriesEqual(current, planned.expectedEntry) ? unchanged : changed).push(planned);
  }
  return { changed, unchanged };
}
