import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  retireSqliteDatabaseWriteScopes,
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { persistSessionTranscriptArchive } from "./session-accessor.sqlite-archive-store-kernel.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive-types.js";
import type {
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
} from "./session-accessor.sqlite-contract.js";
import { conversationPublication } from "./session-accessor.sqlite-conversation-publication.js";
import {
  planSessionStateDeleteIfUnreferenced,
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteSessionEntryRows,
  readExactSessionEntryRow,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  LifecycleRemovalProjectionInput,
  ProjectedLifecycleMutation,
  SessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  collectProjectedReferencedSessionIds,
  readReferencedSessionIds,
  readSessionGenerationIdsForKeys,
  collectSessionStateIdsForEntry,
} from "./session-accessor.sqlite-references.js";
import { getSessionKysely, withSqliteSessionDatabase } from "./session-accessor.sqlite-scope.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { shouldRemoveSessionEntry } from "./session-entry-lifecycle-removal.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

export { shouldRemoveSessionEntry } from "./session-entry-lifecycle-removal.js";

// Transcript-state reclamation owner. Planning stays async-free; transactions revalidate before delete.

export function deleteMaterializedSessionStatePlans(
  database: OpenClawAgentDatabase,
  plans: readonly MaterializedSessionStateDeletePlan[],
  protectedSessionIds?: ReadonlySet<string>,
  excludedSessionKeys?: ReadonlySet<string>,
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
    deleteSqliteSessionStateRows(database, plan.sessionId);
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
  referencedSessionIds?: ReadonlySet<string>;
}): SessionStateDeletePlan[] {
  const candidates = collectSessionStateIdsForEntry(params.entry);
  const referencedSessionIds =
    params.referencedSessionIds ?? readReferencedSessionIds(params.database, undefined, candidates);
  return candidates.flatMap((sessionId) => {
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveTranscript,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: "deleted",
      referencedSessionIds,
      sessionId,
    });
    return plan ? [plan] : [];
  });
}

/** Raw Doctor removals also guard cold changes while the hot blob remains unchanged. */
export function assertRawSessionEntryRemovalUnchanged(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  removal: Extract<SessionEntryLifecycleRemoval, { expectedRawEntryJson: string }>,
): void {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_nodes")
      .select(["entry_json", "snapshot_revision"])
      .where("session_key", "=", sessionKey),
  );
  if (
    !row ||
    row.entry_json !== removal.expectedRawEntryJson ||
    row.snapshot_revision !== removal.expectedSnapshotRevision
  ) {
    throw new Error(`SQLite session entry changed before raw lifecycle removal for ${sessionKey}`);
  }
}

export function selectProjectedLifecycleRemovals(
  database: OpenClawAgentDatabase,
  store: Record<string, SessionEntry>,
  removals: readonly SessionEntryLifecycleRemoval[],
) {
  const removedKeysToArchive = new Set<string>();
  const changedSessionKeys = new Set<string>();
  const projectedRemovals: ProjectedLifecycleMutation["removals"] = [];
  for (const removal of removals) {
    const sessionKey = removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim();
    let entry = removal.exactStoredKey || sessionKey ? store[sessionKey] : undefined;
    if (removal.expectedRawEntryJson !== undefined) {
      assertRawSessionEntryRemovalUnchanged(database, sessionKey, removal);
      entry = structuredClone(removal.expectedEntry);
    }
    if (!shouldRemoveSessionEntry(entry, removal)) {
      continue;
    }
    if (removal.expectedTranscriptSnapshot) {
      const sessionId = entry.sessionId;
      if (
        !sessionId ||
        !sqliteSessionStateDeleteSnapshotsEqual(
          readSessionStateDeleteSnapshot(database.db, sessionId),
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
      expectedEntry: structuredClone(entry),
      removal,
      sessionKey,
    });
    if (removal.archiveRemovedTranscript === true) {
      removedKeysToArchive.add(sessionKey);
    }
    changedSessionKeys.add(sessionKey);
    delete store[sessionKey];
  }
  return { removedKeysToArchive, changedSessionKeys, projectedRemovals };
}

export function finishProjectedLifecycleRemovalPlans(
  database: OpenClawAgentDatabase,
  archiveDirectory: string,
  store: Record<string, SessionEntry>,
  selected: ReturnType<typeof selectProjectedLifecycleRemovals>,
  upsertedEntries: ProjectedLifecycleMutation["upsertedEntries"],
): ProjectedLifecycleMutation {
  const { removedKeysToArchive, changedSessionKeys, projectedRemovals } = selected;
  const removedGenerationIds = readSessionGenerationIdsForKeys(database, removedKeysToArchive);
  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database,
    excludedSessionKeys: changedSessionKeys,
    projectedStore: store,
    candidateSessionIds: uniqueStrings([
      ...projectedRemovals.flatMap(({ expectedEntry }) =>
        collectSessionStateIdsForEntry(expectedEntry),
      ),
      ...removedGenerationIds,
    ]),
  });
  const deletePlans = projectedRemovals.flatMap(({ archiveTranscript, expectedEntry: entry }) =>
    planSessionStateAfterEntryRemoval({
      archiveDirectory,
      archiveTranscript,
      database,
      entry,
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
  for (const sessionId of removedGenerationIds) {
    if (plannedIds.has(sessionId)) {
      continue;
    }
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory,
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
}

/** Removal-only planning shares selection and reference policy with the async upsert owner. */
export function projectSessionEntryLifecycleRemovalsInDatabase(
  database: OpenClawAgentDatabase,
  params: LifecycleRemovalProjectionInput,
): ProjectedLifecycleMutation {
  const store = readSessionEntryStore(database, {
    allowCanonicalRepair: params.allowCanonicalRepair === true,
    sessionKeys: params.removals.map((removal) =>
      removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim(),
    ),
  });
  const selected = selectProjectedLifecycleRemovals(database, store, params.removals);
  if (selected.projectedRemovals.length === 0) {
    return { deletePlans: [], removals: [], upsertedEntries: [] };
  }
  return finishProjectedLifecycleRemovalPlans(
    database,
    params.archiveDirectory,
    store,
    selected,
    [],
  );
}

export function readProjectedLifecycleStore(
  database: OpenClawAgentDatabase,
  params: {
    allowCanonicalRepair?: boolean;
    removals: readonly SessionEntryLifecycleRemoval[];
    upserts: readonly Pick<SessionEntryLifecycleUpsert, "sessionKey" | "relatedSessionKeys">[];
  },
): Record<string, SessionEntry> {
  const sessionKeys = new Set([
    ...params.removals.map((removal) =>
      removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim(),
    ),
    ...params.upserts.flatMap((upsert) => [
      upsert.sessionKey.trim(),
      ...(upsert.relatedSessionKeys ?? []).map(normalizeStoreSessionKey),
    ]),
  ]);
  const options = { allowCanonicalRepair: params.allowCanonicalRepair === true };
  const store = readSessionEntryStore(database, { ...options, sessionKeys: [...sessionKeys] });
  const parentSessionKeys = params.upserts.flatMap((upsert) => {
    const parent = store[upsert.sessionKey.trim()]?.parentSessionKey;
    const key = parent ? normalizeStoreSessionKey(parent) : "";
    return upsert.relatedSessionKeys !== undefined && key && !sessionKeys.has(key) ? [key] : [];
  });
  if (parentSessionKeys.length > 0) {
    Object.assign(
      store,
      readSessionEntryStore(database, { ...options, sessionKeys: parentSessionKeys }),
    );
  }
  return store;
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
    const store = readProjectedLifecycleStore(removalDatabase, params);
    const selected = selectProjectedLifecycleRemovals(removalDatabase, store, params.removals);
    const { projectedRemovals } = selected;
    const upsertedEntries = await buildProjectedLifecycleUpserts(store, selected, params.upserts);
    if (projectedRemovals.length === 0) {
      return {
        deletePlans: [],
        removals: projectedRemovals,
        upsertedEntries,
      };
    }
    // Builders can close the original handle; admit the reference snapshot again.
    return withSqliteSessionDatabase(databaseOptions, (database) => {
      return finishProjectedLifecycleRemovalPlans(
        database,
        params.archiveDirectory,
        store,
        selected,
        upsertedEntries,
      );
    });
  });
}

/** Builders run once outside SQL; commit rereads their exact prepared rows. */
export async function buildProjectedLifecycleUpserts(
  store: Record<string, SessionEntry>,
  selected: ReturnType<typeof selectProjectedLifecycleRemovals>,
  upserts: readonly SessionEntryLifecycleUpsert[],
): Promise<ProjectedLifecycleMutation["upsertedEntries"]> {
  const { projectedRemovals, changedSessionKeys } = selected;
  const upsertedEntries: ProjectedLifecycleMutation["upsertedEntries"] = [];
  for (const upsert of upserts) {
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
    const expectedEntry = store[sessionKey] ? structuredClone(store[sessionKey]) : undefined;
    if (upsert.resetBoundary && !expectedEntry) {
      throw new Error(
        `Cannot append reset boundary without an existing session row: ${sessionKey}`,
      );
    }
    const entry =
      upsert.buildEntry === undefined
        ? upsert.entry
        : await upsert.buildEntry({
            currentEntry: expectedEntry ? structuredClone(expectedEntry) : undefined,
            readEntry: (key) => {
              const related = store[normalizeStoreSessionKey(key)];
              return related ? structuredClone(related) : undefined;
            },
            sessionKey,
          });
    if (!entry) {
      continue;
    }
    const cloned = structuredClone(entry);
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
  return upsertedEntries;
}

function deleteSqliteSessionStateRows(database: OpenClawAgentDatabase, sessionId: string): void {
  const db = getSessionKysely(database.db);
  // The window row cascades canonical transcript tables, but FTS is virtual;
  // clear its projection before dropping the owner row.
  deleteSessionTranscriptIndexInTransaction(database.db, sessionId);
  withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(sessionId)], () =>
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_windows").where("session_id", "=", sessionId),
    ),
  );
  retireSqliteDatabaseWriteScopes(database.db, [sqliteSessionIdWriteScope(sessionId)]);
  conversationPublication.stageRows(database, { removedWindows: [sessionId] });
}

export function deletePlannedLifecycleArtifactEntries(
  database: OpenClawAgentDatabase,
  entries: readonly SessionEntryRemovalPlan[],
): number {
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
