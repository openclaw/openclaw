import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  retireSqliteDatabaseWriteScopes,
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { conversationPublication } from "./session-accessor.sqlite-conversation-publication.js";
import { commitSqliteSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { clearSqliteSessionEntryPreservingWindows } from "./session-accessor.sqlite-entry-clear.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  copySessionNodeArtifactsForRepair,
  deleteSessionDeliveryArtifacts,
  deleteSessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export {
  writeSessionEntry,
  writeArchivedSessionEntries,
} from "./session-accessor.sqlite-entry-write.js";
export {
  parseReadableSqliteSessionEntryRow,
  readExactSessionEntryRow,
  readExactSessionEntryRowValidated,
  readSessionEntryRow,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
export {
  readSessionEntryCount,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-inventory.js";
export {
  normalizeLifecycleTarget,
  readLifecycleTargetSnapshot,
  readSessionIdentitySnapshot,
  readSessionEntrySelectionSnapshot,
  resolveLifecyclePrimaryEntry,
} from "./session-accessor.sqlite-entry-snapshot.js";

export function deleteSessionEntryRows(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  options: {
    deleteOwnedWindows?: boolean;
    deliveryCleanupKeys?: readonly string[];
    validatedEntry?: SessionEntry;
    postimages?: SessionEntryWritePostimages;
  } = {},
): boolean {
  // Lifecycle deletion reuses its transaction snapshot; Doctor also supplies validated legacy rows.
  const previousEntry =
    options.validatedEntry ?? readExactSessionEntryRow(database, sessionKey)?.entry;
  if (previousEntry) {
    commitSqliteSessionDeletion(sessionKey, previousEntry);
  }
  const db = getSessionKysely(database.db);
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "=", sessionKey),
  ).rows;
  // Skip the survivor scan when maintenance reclaimed every window. Otherwise, project
  // reference metadata before acquiring rows to avoid loading unrelated saved prompts.
  const survivingNodes =
    windows.length > 0
      ? executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select([
              "current_session_id",
              "entry_json",
              "session_key",
              "entry_valid",
              "updated_at",
            ])
            .where("session_key", "!=", sessionKey)
            .orderBy("session_key", "asc"),
        ).rows
      : [];
  const ownedSessionIds: string[] = [];
  let transcriptInventoryUnchanged = options.deleteOwnedWindows !== true;
  for (const window of windows) {
    const survivingNode = survivingNodes.find((node) => {
      if (node.current_session_id === window.session_id) {
        return true;
      }
      const entry = parseSessionEntryRow(node);
      return entry ? collectSessionStateIdsForEntry(entry).includes(window.session_id) : false;
    });
    if (survivingNode) {
      transcriptInventoryUnchanged &&=
        resolveAgentIdFromSessionKey(sessionKey, database.agentId) ===
          resolveAgentIdFromSessionKey(survivingNode.session_key, database.agentId) &&
        isInternalSessionEffectsKey(sessionKey) ===
          isInternalSessionEffectsKey(survivingNode.session_key);
      withSqliteDatabaseWriteScope(
        database.db,
        [sessionKey, survivingNode.session_key, sqliteSessionIdWriteScope(window.session_id)],
        () =>
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("session_windows")
              .set({ session_key: survivingNode.session_key })
              .where("session_id", "=", window.session_id),
          ),
      );
      conversationPublication.stageRows(database, {
        nodes: [
          {
            ...survivingNode,
            entry_session_id: parseSessionEntryRow(survivingNode)?.sessionId ?? null,
          },
        ],
        rehomes: [
          { kind: "rehome", sessionId: window.session_id, sessionKey: survivingNode.session_key },
        ],
      });
      for (const postimage of options.postimages?.values() ?? []) {
        if (postimage.window.session_id === window.session_id) {
          postimage.window = { ...postimage.window, session_key: survivingNode.session_key };
        }
      }
    } else {
      ownedSessionIds.push(window.session_id);
    }
  }
  const remainingWindow = options.deleteOwnedWindows
    ? undefined
    : executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_windows")
          .select(["session_id", "updated_at"])
          .where("session_key", "=", sessionKey)
          .orderBy("updated_at", "desc")
          .orderBy("session_id", "asc")
          .limit(1),
      );
  withSqliteDatabaseWriteScope(
    database.db,
    [sessionKey, ...windows.map((window) => sqliteSessionIdWriteScope(window.session_id))],
    () => {
      if (options.deleteOwnedWindows) {
        deleteSessionDeliveryArtifacts(database, sessionKey, options.deliveryCleanupKeys);
      }
      if (options.deleteOwnedWindows || remainingWindow) {
        deleteSessionNodeArtifacts(database, sessionKey);
      }
      if (remainingWindow) {
        clearSqliteSessionEntryPreservingWindows(database, {
          sessionId: remainingWindow.session_id,
          sessionKey,
          updatedAt: remainingWindow.updated_at,
        });
      } else {
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
        );
        conversationPublication.stageRows(database, {
          removedNodes: [sessionKey],
          removedWindows: ownedSessionIds,
        });
        retireSqliteDatabaseWriteScopes(database.db, [
          sessionKey,
          ...ownedSessionIds.map(sqliteSessionIdWriteScope),
        ]);
      }
    },
  );
  options.postimages?.delete(sessionKey);
  publishSessionEntryCacheInvalidation(database, { sessionKey, facts: { kind: "removed" } });
  return transcriptInventoryUnchanged;
}

export function deleteLifecycleTargetRows(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  snapshot: SqliteLifecycleTargetSnapshot,
): boolean {
  let transcriptInventoryUnchanged = true;
  for (const sessionKey of uniqueStrings([target.canonicalKey, ...target.storeKeys])) {
    const trimmed = sessionKey.trim();
    if (trimmed) {
      const unchanged = deleteSessionEntryRows(database, trimmed, {
        validatedEntry: snapshot.find((row) => row.sessionKey === trimmed)?.entry,
      });
      transcriptInventoryUnchanged &&= unchanged;
    }
  }
  return transcriptInventoryUnchanged;
}

export function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
  options: {
    rehomeMembers?: boolean;
    validatedEntries?: ReadonlyMap<string, SessionEntry>;
    postimages?: SessionEntryWritePostimages;
  } = {},
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    const previousEntry =
      options.validatedEntries?.get(legacyKey) ??
      readExactSessionEntryRow(database, legacyKey)?.entry;
    if (previousEntry) {
      commitSqliteSessionDeletion(legacyKey, previousEntry);
    }
    rehomeSessionWindows(database, sessionKey, [legacyKey], options.postimages);
    copySessionNodeArtifactsForRepair(database, database, [legacyKey], sessionKey, {
      includeMembers: options.rehomeMembers,
      postimages: options.postimages,
    });
    withSqliteDatabaseWriteScope(database.db, [legacyKey], () =>
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("session_nodes").where("session_key", "=", legacyKey),
      ),
    );
    retireSqliteDatabaseWriteScopes(database.db, [legacyKey]);
    conversationPublication.stageRows(database, { removedNodes: [legacyKey] });
    options.postimages?.delete(legacyKey);
    const canonicalPostimage = options.postimages?.get(sessionKey);
    if (canonicalPostimage) {
      canonicalPostimage.changed = true;
    }
    publishSessionEntryCacheInvalidation(database, { sessionKey: legacyKey });
  }
  publishSessionEntryCacheInvalidation(database, { sessionKey });
}

/** Move retained generations to the canonical node before removing key aliases. */
export function rehomeSessionWindows(
  database: OpenClawAgentDatabase,
  canonicalKey: string,
  previousKeys: Iterable<string>,
  postimages?: SessionEntryWritePostimages,
): void {
  const legacyKeys = uniqueStrings([...previousKeys].map((key) => key.trim())).filter(
    (key) => key && key !== canonicalKey,
  );
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  // Offline repair can move shared windows whose other logical readers are not in this key set.
  withoutSqliteDatabaseWriteScope(database.db, () =>
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_windows")
        .set({ session_key: canonicalKey })
        .where("session_key", "in", legacyKeys),
    ),
  );
  conversationPublication.stageRows(database, {
    rehomes: [{ kind: "rehome", sessionKey: canonicalKey, previousKeys: legacyKeys }],
  });
  for (const postimage of postimages?.values() ?? []) {
    if (legacyKeys.includes(postimage.window.session_key)) {
      postimage.window = { ...postimage.window, session_key: canonicalKey };
    }
  }
}
