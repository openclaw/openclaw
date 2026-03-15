/**
 * message-logger.ts — Structured message logging for the memory database.
 *
 * logMessage():    Insert a single inbound/outbound message into `message_log`.
 * queryMessages(): Paginated search across the message log with optional filters.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type MessageLogRow = {
  id: string;
  session_key: string;
  direction: string;
  role: string;
  channel: string | null;
  account_id: string | null;
  sender_id: string | null;
  sender_name: string | null;
  recipient: string | null;
  body: string | null;
  media_url: string | null;
  media_type: string | null;
  media_urls: string | null;
  chat_type: string | null;
  group_subject: string | null;
  thread_id: string | null;
  reply_to_id: string | null;
  message_sid: string | null;
  lang: string | null;
  sentiment: string | null;
  theme: string | null;
  created_at: string;
  enriched_at: string | null;
};

export function logMessage(params: {
  db: DatabaseSync;
  sessionKey: string;
  direction: "inbound" | "outbound";
  role: "user" | "assistant";
  channel?: string;
  accountId?: string;
  senderId?: string;
  senderName?: string;
  recipient?: string;
  body?: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaUrls?: string[];
  chatType?: string;
  groupSubject?: string;
  threadId?: string;
  replyToId?: string;
  messageSid?: string;
}): void {
  const id = randomUUID();
  const mediaUrlsJson = params.mediaUrls?.length ? JSON.stringify(params.mediaUrls) : null;

  try {
    params.db
      .prepare(
        `INSERT INTO message_log
         (id, session_key, direction, role, channel, account_id, sender_id, sender_name,
          recipient, body, media_url, media_type, media_urls, chat_type, group_subject,
          thread_id, reply_to_id, message_sid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        id,
        params.sessionKey,
        params.direction,
        params.role,
        params.channel ?? null,
        params.accountId ?? null,
        params.senderId ?? null,
        params.senderName ?? null,
        params.recipient ?? null,
        params.body ?? null,
        params.mediaUrl ?? null,
        params.mediaType ?? null,
        mediaUrlsJson,
        params.chatType ?? null,
        params.groupSubject ?? null,
        params.threadId ?? null,
        params.replyToId ?? null,
        params.messageSid ?? null,
      );
  } catch {
    // Non-fatal: message logging is fire-and-forget.
    return;
  }

  // Also insert into FTS if the table exists and there's body text.
  if (params.body) {
    try {
      params.db
        .prepare(
          `INSERT INTO message_log_fts (body, id, session_key, channel, sender_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(params.body, id, params.sessionKey, params.channel ?? null, params.senderId ?? null);
    } catch {
      // FTS table may not exist — non-fatal.
    }
  }
}

export function queryMessages(params: {
  db: DatabaseSync;
  sessionKey?: string;
  channel?: string;
  senderId?: string;
  direction?: string;
  search?: string;
  limit?: number;
  offset?: number;
  before?: string;
  after?: string;
}): { messages: MessageLogRow[]; total: number } {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);

  const conditions: string[] = [];
  const args: (string | number | null)[] = [];

  if (params.sessionKey) {
    conditions.push("m.session_key = ?");
    args.push(params.sessionKey);
  }
  if (params.channel) {
    conditions.push("m.channel = ?");
    args.push(params.channel);
  }
  if (params.senderId) {
    conditions.push("m.sender_id = ?");
    args.push(params.senderId);
  }
  if (params.direction) {
    conditions.push("m.direction = ?");
    args.push(params.direction);
  }
  if (params.before) {
    conditions.push("m.created_at < ?");
    args.push(params.before);
  }
  if (params.after) {
    conditions.push("m.created_at > ?");
    args.push(params.after);
  }

  let fromClause = "message_log m";
  if (params.search) {
    // Try FTS first; fall back to LIKE if FTS unavailable.
    try {
      params.db.prepare("SELECT 1 FROM message_log_fts LIMIT 0").all();
      fromClause = "message_log_fts fts JOIN message_log m ON fts.id = m.id";
      conditions.push("fts.body MATCH ?");
      args.push(params.search);
    } catch {
      conditions.push("m.body LIKE ?");
      args.push(`%${params.search}%`);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = params.db
    .prepare(`SELECT COUNT(*) as cnt FROM ${fromClause} ${where}`)
    .get(...args) as { cnt: number } | undefined;
  const total = countRow?.cnt ?? 0;

  const rows = params.db
    .prepare(`SELECT m.* FROM ${fromClause} ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as MessageLogRow[];

  return { messages: rows, total };
}
