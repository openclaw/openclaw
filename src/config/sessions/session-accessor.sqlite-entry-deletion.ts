import { isMainThread } from "node:worker_threads";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  retireSqliteDatabaseWriteScopes,
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { commitSqliteSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { clearSqliteSessionEntryPreservingWindows } from "./session-accessor.sqlite-entry-clear.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  deleteSessionDeliveryArtifacts,
  deleteSessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import { assertQuestionLifecycleWorker } from "./session-question-recovery-owner.js";
import { retireSessionQuestionsInDatabase } from "./session-questions-retirement.worker.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export function deleteSessionEntryRows(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  options: {
    deleteOwnedWindows?: boolean;
    deliveryCleanupKeys?: readonly string[];
    validatedEntry?: SessionEntry;
    postimages?: SessionEntryWritePostimages;
  } = {},
): void {
  // Doctor supplies the exact row it validated; the runtime parser deliberately rejects that shape.
  const previousEntry =
    options.validatedEntry ?? readExactSessionEntryRow(database, sessionKey)?.entry;
  assertQuestionLifecycleWorker(previousEntry);
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
            .select(["current_session_id", "entry_json", "session_key"])
            .where("session_key", "!=", sessionKey)
            .orderBy("session_key", "asc"),
        ).rows
      : [];
  const ownedSessionIds: string[] = [];
  for (const window of windows) {
    const survivingNode = survivingNodes.find((node) => {
      if (node.current_session_id === window.session_id) {
        return true;
      }
      const entry = parseSessionEntryRow(node);
      return entry ? collectSessionStateIdsForEntry(entry).includes(window.session_id) : false;
    });
    if (survivingNode) {
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
        retireSqliteDatabaseWriteScopes(database.db, [
          sessionKey,
          ...ownedSessionIds.map(sqliteSessionIdWriteScope),
        ]);
      }
      if (previousEntry && !isMainThread) {
        retireSessionQuestionsInDatabase(
          database,
          {
            sessionKey,
            sessionId: previousEntry.sessionId,
            lifecycleRevision: previousEntry.lifecycleRevision,
          },
          `retired:${previousEntry.sessionId}`,
        );
      }
    },
  );
  options.postimages?.delete(sessionKey);
  publishSessionEntryCacheInvalidation(database, { sessionKey, facts: { kind: "removed" } });
}
