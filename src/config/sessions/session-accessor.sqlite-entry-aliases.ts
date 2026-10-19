import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  retireSqliteDatabaseWriteScopes,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { conversationPublication } from "./session-accessor.sqlite-conversation-publication.js";
import { commitSqliteSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

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
