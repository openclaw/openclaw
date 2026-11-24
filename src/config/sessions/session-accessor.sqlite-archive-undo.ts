import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { ARCHIVE_UNDO_CHANGED, type SessionArchiveUndoIntent } from "./session-archive-undo.js";
import { isPinnableSessionEntry } from "./session-pin-policy.js";
import type { SessionEntry } from "./types.js";

export function prepareSessionArchiveUndoWrite({
  database,
  sessionKey,
  previous,
  next,
  options,
  actorPreparation,
}: {
  database: OpenClawAgentDatabase;
  sessionKey: string;
  previous: SessionEntry | undefined;
  next: SessionEntry;
  options: { archiveUndo?: SessionArchiveUndoIntent; allowStoredAliases?: boolean };
  actorPreparation: boolean;
}): "ready" | "requires-transaction" {
  const intent: SessionArchiveUndoIntent | undefined =
    options.archiveUndo ??
    (previous?.archivedAt !== undefined &&
    (options.allowStoredAliases ||
      previous.sessionId !== next.sessionId ||
      previous.lifecycleRevision !== next.lifecycleRevision ||
      previous.archivedAt !== next.archivedAt ||
      previous.pinnedAt !== next.pinnedAt)
      ? { kind: "invalidate" }
      : undefined);
  if (!intent || (intent.kind === "invalidate" && previous?.archivedAt === undefined)) {
    return "ready";
  }
  // Marker changes require the ordinary multi-statement transaction, never a single actor effect.
  if (actorPreparation) {
    return "requires-transaction";
  }
  applySessionArchiveUndo(database, sessionKey, intent, previous, next);
  return "ready";
}

/** Only called inside the normal entry transaction. Neither the digest nor the former pin bit is session metadata. */
function applySessionArchiveUndo(
  database: OpenClawAgentDatabase,
  key: string,
  intent: SessionArchiveUndoIntent,
  previous: SessionEntry | undefined,
  next: SessionEntry,
): void {
  if (isPostgresSqlConnection(database.db) && intent.kind !== "invalidate") {
    throw new Error("Archive Undo is unavailable for this session store.");
  }
  const db = getSessionKysely(database.db);
  const update = db.updateTable("session_nodes").where("session_key", "=", key);
  if (intent.kind === "invalidate") {
    executeSqliteQuerySync(
      database.db,
      update.set({ archive_undo_marker: null }).where("archive_undo_marker", "is not", null),
    );
    return;
  }
  const now = Date.now();
  if (
    !previous ||
    previous.sessionId !== next.sessionId ||
    previous.lifecycleRevision !== next.lifecycleRevision ||
    !(intent.expiresAt > now)
  ) {
    throw new Error(ARCHIVE_UNDO_CHANGED);
  }
  const target = update.where("current_session_id", "=", next.sessionId);
  if (intent.kind === "archive") {
    if (
      previous.archivedAt !== undefined ||
      next.archivedAt === undefined ||
      next.pinnedAt !== undefined ||
      !executeSqliteQueryTakeFirstSync(
        database.db,
        target
          .set({
            archive_undo_marker: `${previous.pinnedAt === undefined ? 0 : 1}:${intent.digest}`,
          })
          .where("archived_at", "is", null)
          .returning("session_key"),
      )
    ) {
      throw new Error(ARCHIVE_UNDO_CHANGED);
    }
    return;
  }
  if (previous.archivedAt === undefined || next.archivedAt !== undefined) {
    throw new Error(ARCHIVE_UNDO_CHANGED);
  }
  // The writer reads the recorded preimage in its own transaction, never the requester's personal flag.
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_nodes").select("archive_undo_marker").where("session_key", "=", key),
  );
  const marker = row?.archive_undo_marker;
  if (
    (marker !== `0:${intent.digest}` && marker !== `1:${intent.digest}`) ||
    !executeSqliteQueryTakeFirstSync(
      database.db,
      target
        .set({ archive_undo_marker: null })
        .where("archive_undo_marker", "=", marker)
        .where("archived_at", "is not", null)
        .returning("session_key"),
    )
  ) {
    throw new Error(ARCHIVE_UNDO_CHANGED);
  }
  if (marker.startsWith("1:")) {
    if (!isPinnableSessionEntry(key, next)) {
      throw new Error(ARCHIVE_UNDO_CHANGED);
    }
    next.pinnedAt = now;
    delete next.snoozedAt;
    delete next.snoozedUntil;
  }
}
