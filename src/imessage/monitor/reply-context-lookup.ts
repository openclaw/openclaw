/**
 * Looks up reply/quote context from the iMessage chat.db when the imsg CLI
 * does not provide reply_to_* fields. Populates reply_to_id, reply_to_text,
 * reply_to_sender from the message and handle tables.
 * See: https://github.com/openclaw/openclaw/issues/42266
 */

import { requireNodeSqlite } from "../../memory/sqlite.js";
import { resolveUserPath } from "../../utils.js";

export type ReplyContext = {
  reply_to_id: string;
  reply_to_text: string | null;
  reply_to_sender: string | null;
};

/**
 * Resolves reply context for a message by reading chat.db. Uses message ROWID
 * (payload message.id from imsg) to find reply_to_guid, then loads the quoted
 * message's guid, text, and sender. Returns null if the message is not a reply,
 * db is missing/invalid, or schema differs (e.g. older macOS without reply_to_guid).
 */
export function lookupReplyContextSync(dbPath: string, messageRowId: number): ReplyContext | null {
  const resolvedPath = dbPath.trim() ? resolveUserPath(dbPath) : "";
  if (!resolvedPath) {
    return null;
  }
  try {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolvedPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 3000");
      const replyToGuidRow = db
        .prepare("SELECT reply_to_guid FROM message WHERE ROWID = ?")
        .get(messageRowId) as { reply_to_guid?: string | null } | undefined;
      const replyToGuid =
        replyToGuidRow?.reply_to_guid != null && String(replyToGuidRow.reply_to_guid).trim()
          ? String(replyToGuidRow.reply_to_guid).trim()
          : null;
      if (!replyToGuid) {
        return null;
      }
      const quotedRow = db
        .prepare(
          "SELECT m.guid, m.text, h.id AS sender FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID WHERE m.guid = ?",
        )
        .get(replyToGuid) as
        | { guid?: string; text?: string | null; sender?: string | null }
        | undefined;
      if (!quotedRow) {
        return null;
      }
      const id = quotedRow.guid != null ? String(quotedRow.guid) : replyToGuid;
      const text =
        quotedRow.text != null && String(quotedRow.text).trim() !== ""
          ? String(quotedRow.text).trim()
          : null;
      const sender =
        quotedRow.sender != null && String(quotedRow.sender).trim() !== ""
          ? String(quotedRow.sender).trim()
          : null;
      return { reply_to_id: id, reply_to_text: text, reply_to_sender: sender };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
