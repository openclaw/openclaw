import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { SessionWorkStartInvalidatedError } from "./lifecycle.js";
import { readSessionEntryInstanceId } from "./session-accessor.sqlite-entry-identity.js";
import { reactionDb, reactionRows, summarizeReactions } from "./session-reaction-store.read.js";
import type {
  SessionReactionWrite,
  SetSessionReactionParams,
} from "./session-reaction-store.types.js";

export class SessionReactionLimitError extends Error {
  constructor() {
    super("reaction limit reached");
    this.name = "SessionReactionLimitError";
  }
}

/** The message was deleted between the caller's asynchronous read and this transaction. */
export class SessionReactionMessageMissingError extends Error {
  constructor() {
    super("unknown message");
    this.name = "SessionReactionMessageMissingError";
  }
}

export function setSessionReactionInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: SetSessionReactionParams,
): SessionReactionWrite {
  if (readSessionEntryInstanceId(database, sessionKey) !== params.expectedSessionId) {
    throw new SessionWorkStartInvalidatedError("session changed before reaction mutation");
  }
  const db = reactionDb(database);
  const rows = executeSqliteQuerySync(
    database.db,
    reactionRows(database, sessionKey, params.expectedSessionId).where(
      "message_id",
      "=",
      params.messageId,
    ),
  ).rows;
  const existing = rows.some(
    (row) => row.emoji === params.emoji && row.identity_id === params.identityId,
  );
  if (params.remove ? !existing : existing) {
    return {
      reactions: summarizeReactions(rows),
      newestRemainingEmoji: rows.at(-1)?.emoji,
      changed: false,
    };
  }
  if (params.remove) {
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("session_reactions")
        .where("session_key", "=", sessionKey)
        .where("session_id", "=", params.expectedSessionId)
        .where("message_id", "=", params.messageId)
        .where("emoji", "=", params.emoji)
        .where("identity_id", "=", params.identityId),
    );
  } else {
    const count =
      executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_reactions")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("session_key", "=", sessionKey)
          .where("session_id", "=", params.expectedSessionId),
      )?.count ?? 0;
    if (
      count >= 5_000 ||
      rows.filter((row) => row.identity_id === params.identityId).length >= 20
    ) {
      throw new SessionReactionLimitError();
    }
    // The caller looked the message up asynchronously; a transcript rewrite can
    // have deleted it (and pruned its reactions) since, so re-check inside the
    // transaction rather than insert a reaction for a message that is gone.
    const identity = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select("event_id")
        .where("session_id", "=", params.expectedSessionId)
        .where("event_id", "=", params.messageId),
    );
    if (!identity) {
      throw new SessionReactionMessageMissingError();
    }
    executeSqliteQuerySync(
      database.db,
      db.insertInto("session_reactions").values({
        session_key: sessionKey,
        session_id: params.expectedSessionId,
        message_id: params.messageId,
        emoji: params.emoji,
        identity_id: params.identityId,
        identity_label: params.identityLabel ?? null,
        created_at: Date.now(),
      }),
    );
  }
  const remainingRows = executeSqliteQuerySync(
    database.db,
    reactionRows(database, sessionKey, params.expectedSessionId).where(
      "message_id",
      "=",
      params.messageId,
    ),
  ).rows;
  return {
    reactions: summarizeReactions(remainingRows),
    newestRemainingEmoji: remainingRows.at(-1)?.emoji,
    changed: true,
  };
}
