import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionEntryWriteQueries } from "./session-accessor.sqlite-entry-write-queries.js";
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
  const queries = getSessionEntryWriteQueries(database.db).archiveUndo;
  if (intent.kind === "invalidate") {
    queries.clear({ key });
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
  const target = { key, sessionId: next.sessionId };
  if (intent.kind === "archive") {
    if (
      previous.archivedAt !== undefined ||
      next.archivedAt === undefined ||
      next.pinnedAt !== undefined ||
      !queries.issue({
        ...target,
        marker: `${previous.pinnedAt === undefined ? 0 : 1}:${intent.digest}`,
      }).rows[0]
    ) {
      throw new Error(ARCHIVE_UNDO_CHANGED);
    }
    return;
  }
  if (previous.archivedAt === undefined || next.archivedAt !== undefined) {
    throw new Error(ARCHIVE_UNDO_CHANGED);
  }
  // The writer reads the recorded preimage in its own transaction, never the requester's personal flag.
  const marker = queries.read({ key }).rows[0]?.archive_undo_marker;
  if (
    (marker !== `0:${intent.digest}` && marker !== `1:${intent.digest}`) ||
    !queries.consume({ ...target, marker }).rows[0]
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
