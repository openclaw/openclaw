import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { SessionEntryLifecycleUpsertConflictError } from "./session-accessor.lifecycle-error.js";
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
import { prepareLifecycleIdentityEntries } from "./session-accessor.sqlite-identity.js";
import { SESSION_LIFECYCLE_WORKER_SELECTED_JSON_BYTES } from "./session-accessor.sqlite-lifecycle-budget.js";
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
import type { SessionEntryReplacementCommitted } from "./session-accessor.sqlite-replacement-state.js";
import { appendSessionResetBoundary } from "./session-accessor.sqlite-reset-boundary.js";
import { getSessionKysely, type ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryLifecycleCommit = {
  projected: ProjectedLifecycleMutation;
  removalPlans: MaterializedSessionStateDeletePlan[];
  materializationFailed: boolean;
  allowCanonicalRepair?: boolean;
  scope: ResolvedSqliteScope;
  maintenance?: SessionEntryMaintenanceInput;
};
export type SessionEntryLifecycleCommitted = SessionEntryReplacementCommitted & {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
  beforeCount: number;
  removedSessionKeys: string[];
};
type SessionEntryLifecycleNativeCallbacks = {
  afterUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  afterFreshUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  maintenance?: (database: OpenClawAgentDatabase) => SessionEntryMaintenancePlan;
};

function activeLifecycleRemovals(input: SessionEntryLifecycleCommit) {
  return input.materializationFailed
    ? input.projected.removals.filter((entry) => entry.removal.archiveRemovedTranscript !== true)
    : input.projected.removals;
}

/** A competing writer can grow a row after preparation; refuse before decoding or changing it. */
export function assertSessionEntryLifecycleWorkerRowsBounded(
  database: OpenClawAgentDatabase,
  input: SessionEntryLifecycleCommit,
): void {
  const activeRemovals = activeLifecycleRemovals(input);
  const keys = [
    ...activeRemovals.map((removal) => removal.sessionKey),
    ...input.projected.upsertedEntries.map((upsert) => upsert.sessionKey),
  ];
  const query = getSessionKysely(database.db)
    .selectFrom("session_nodes")
    .select("session_key")
    .where("session_key", "in", sqliteStringSet(keys))
    .where((eb) =>
      eb(
        eb.fn<number>("length", [eb.cast("entry_json", "blob")]),
        ">",
        SESSION_LIFECYCLE_WORKER_SELECTED_JSON_BYTES,
      ),
    )
    .limit(1);
  const oversized = executeSqliteQuerySync(database.db, query).rows[0];
  if (!oversized) {
    return;
  }
  const key = oversized.session_key;
  const removal = activeRemovals.some((entry) => entry.sessionKey === key);
  const upsert = input.projected.upsertedEntries.some((entry) => entry.sessionKey === key);
  if (!removal && upsert) {
    throw new SessionEntryLifecycleUpsertConflictError(key);
  }
  throw new Error(
    upsert
      ? `SQLite session entry has stale lifecycle state for ${key}`
      : `SQLite session entry changed before lifecycle removal for ${key}`,
  );
}

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

/** Shared transaction kernel for durable worker commits and native rollback/Doctor callbacks. */
export function commitSessionEntryLifecycleInDatabase(
  transactionDb: OpenClawAgentDatabase,
  input: SessionEntryLifecycleCommit,
  callbacks: SessionEntryLifecycleNativeCallbacks = {},
): SessionEntryLifecycleCommitted {
  const { projected, removalPlans, scope: resolved } = input;
  const removedSessionKeys: string[] = [];
  const progressResetKeys: string[] = [];
  const beforeCount = readSessionEntryCount(transactionDb);
  const validatedRemovals = activeLifecycleRemovals(input).filter((removal) => {
    const entry = readProjectedRemovalEntry(transactionDb, removal, input.allowCanonicalRepair);
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
    transactionDb,
    removalPlans,
    undefined,
    new Set(validatedRemovals.map((removal) => removal.sessionKey)),
  );
  const legacyReplacementTargets = new Map<
    string,
    { canonicalKey: string; rehomeMembers: boolean }
  >();
  const current = new Map<string, SessionEntry>();
  for (const {
    sessionKey,
    entry,
    expectedEntry,
    routeContext,
    resetBoundary,
  } of projected.upsertedEntries) {
    const sameKeyRemoval = validatedRemovals.find((removal) => removal.sessionKey === sessionKey);
    const currentEntry = sameKeyRemoval
      ? readProjectedRemovalEntry(transactionDb, sameKeyRemoval, input.allowCanonicalRepair)
      : (input.allowCanonicalRepair
          ? readExactSessionEntryRowForCanonicalRepair(transactionDb, sessionKey, {
              allowMalformedRowRepair: true,
            })
          : readExactSessionEntryRow(transactionDb, sessionKey)
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
      const boundaryScope = { ...resolved, sessionId: expectedEntry.sessionId, sessionKey };
      if (appendSessionResetBoundary(transactionDb, boundaryScope, expectedEntry, resetBoundary)) {
        progressResetKeys.push(sessionKey);
      }
    }
    const written = writeSessionEntry(transactionDb, sessionKey, entry, {
      allowStoredAliases: input.allowCanonicalRepair === true,
      preserveNodeSuggestions: input.allowCanonicalRepair === true,
      previousEntry: expectedCurrentEntry ?? null,
      ...(routeContext !== undefined ? { routeContext } : {}),
    });
    current.set(sessionKey, written);
    const relatedRemovalKeys = validatedRemovals.flatMap((removal) => {
      const removedSessionId = removal.expectedEntry.sessionId;
      return removal.sessionKey !== sessionKey &&
        (removedSessionId === entry.sessionId || removedSessionId === entry.previousSessionId)
        ? [removal.sessionKey]
        : [];
    });
    rehomeSessionWindows(transactionDb, sessionKey, relatedRemovalKeys);
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
  callbacks.afterUpsertsInTransaction?.(transactionDb);
  callbacks.afterFreshUpsertsInTransaction?.(transactionDb);
  const upsertedKeys = new Set(projected.upsertedEntries.map((upsert) => upsert.sessionKey));
  for (const removal of validatedRemovals) {
    if (upsertedKeys.has(removal.sessionKey)) {
      continue;
    }
    const entry = readProjectedRemovalEntry(transactionDb, removal, input.allowCanonicalRepair);
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
      deleteLegacySessionEntryRows(transactionDb, [removal.sessionKey], replacement.canonicalKey, {
        rehomeMembers: replacement.rehomeMembers,
        validatedEntries: new Map([[removal.sessionKey, entry]]),
      });
    } else {
      deleteSessionEntryRows(transactionDb, removal.sessionKey, {
        deleteOwnedWindows: removal.removal.deleteOwnedWindows === true,
        deliveryCleanupKeys: removal.removal.deliveryCleanupKeys,
        validatedEntry: entry,
      });
    }
    removedSessionKeys.push(removal.sessionKey);
  }
  const maintenance = input.maintenance;
  const preservation = maintenance?.preservation;
  const maintenancePlan = callbacks.maintenance
    ? callbacks.maintenance(transactionDb)
    : maintenance && preservation
      ? applySessionEntryMaintenanceInDatabase(transactionDb, maintenance, () => preservation)
      : emptySessionEntryMaintenancePlan();
  return {
    ...prepareLifecycleIdentityEntries(projected, removedSessionKeys),
    current,
    membershipInvalidatedKeys: [
      ...new Set([...legacyReplacementTargets.values()].map(({ canonicalKey }) => canonicalKey)),
    ],
    maintenancePlans: [maintenancePlan],
    archivedTranscripts,
    progressResetKeys,
    beforeCount,
    removedSessionKeys,
  };
}
