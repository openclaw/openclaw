/**
 * WhatsApp History Database
 * SQLite + FTS5 for full-text search across all messages
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../utils.js";

const DB_PATH = resolveUserPath("~/.openclaw/data/whatsapp-history.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Create tables
  db.exec(`
    -- Main messages table
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      chat_name TEXT,
      sender_jid TEXT,
      sender_name TEXT,
      sender_pushname TEXT,
      from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      message_type TEXT,
      text_content TEXT,
      caption TEXT,
      quoted_id TEXT,
      quoted_text TEXT,
      raw_json TEXT,
      source TEXT DEFAULT 'live',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Full-text search index
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text_content,
      caption,
      sender_name,
      chat_name,
      content='messages',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text_content, caption, sender_name, chat_name)
      VALUES (NEW.rowid, NEW.text_content, NEW.caption, NEW.sender_name, NEW.chat_name);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_content, caption, sender_name, chat_name)
      VALUES ('delete', OLD.rowid, OLD.text_content, OLD.caption, OLD.sender_name, OLD.chat_name);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_content, caption, sender_name, chat_name)
      VALUES ('delete', OLD.rowid, OLD.text_content, OLD.caption, OLD.sender_name, OLD.chat_name);
      INSERT INTO messages_fts(rowid, text_content, caption, sender_name, chat_name)
      VALUES (NEW.rowid, NEW.text_content, NEW.caption, NEW.sender_name, NEW.chat_name);
    END;

    -- Contacts table for name resolution
    CREATE TABLE IF NOT EXISTS contacts (
      jid TEXT PRIMARY KEY,
      name TEXT,
      notify TEXT,
      phone TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Chats table for chat metadata
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      is_group INTEGER DEFAULT 0,
      participant_count INTEGER,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_jid);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_from_me ON messages(from_me);
  `);

  return db;
}

export interface MessageRecord {
  id: string;
  chat_jid: string;
  chat_name?: string;
  sender_jid?: string;
  sender_name?: string;
  sender_pushname?: string;
  from_me: boolean;
  timestamp: number;
  message_type?: string;
  text_content?: string;
  caption?: string;
  quoted_id?: string;
  quoted_text?: string;
  raw_json?: string;
  source?: string;
}

export function insertMessage(msg: MessageRecord): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO messages 
    (id, chat_jid, chat_name, sender_jid, sender_name, sender_pushname, from_me, 
     timestamp, message_type, text_content, caption, quoted_id, quoted_text, raw_json, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    msg.id,
    msg.chat_jid,
    msg.chat_name || null,
    msg.sender_jid || null,
    msg.sender_name || null,
    msg.sender_pushname || null,
    msg.from_me ? 1 : 0,
    msg.timestamp,
    msg.message_type || null,
    msg.text_content || null,
    msg.caption || null,
    msg.quoted_id || null,
    msg.quoted_text || null,
    msg.raw_json || null,
    msg.source || "live",
  );
}

export function insertMessages(messages: MessageRecord[]): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages 
    (id, chat_jid, chat_name, sender_jid, sender_name, sender_pushname, from_me, 
     timestamp, message_type, text_content, caption, quoted_id, quoted_text, raw_json, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((msgs: MessageRecord[]) => {
    let count = 0;
    for (const msg of msgs) {
      const result = stmt.run(
        msg.id,
        msg.chat_jid,
        msg.chat_name || null,
        msg.sender_jid || null,
        msg.sender_name || null,
        msg.sender_pushname || null,
        msg.from_me ? 1 : 0,
        msg.timestamp,
        msg.message_type || null,
        msg.text_content || null,
        msg.caption || null,
        msg.quoted_id || null,
        msg.quoted_text || null,
        msg.raw_json || null,
        msg.source || "live",
      );
      if (result.changes > 0) count++;
    }
    return count;
  });

  return insertMany(messages);
}

export interface SearchOptions {
  query?: string;
  chat?: string;
  sender?: string;
  fromMe?: boolean;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  id: string;
  chat_jid: string;
  chat_name: string | null;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: boolean;
  timestamp: number;
  text_content: string | null;
  caption: string | null;
  message_type: string | null;
}

export function searchMessages(opts: SearchOptions): SearchResult[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.query) {
    conditions.push(`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`);
    params.push(opts.query);
  }

  if (opts.chat) {
    conditions.push(`(m.chat_jid LIKE ? OR m.chat_name LIKE ?)`);
    params.push(`%${opts.chat}%`, `%${opts.chat}%`);
  }

  if (opts.sender) {
    conditions.push(`(m.sender_jid LIKE ? OR m.sender_name LIKE ? OR m.sender_pushname LIKE ?)`);
    params.push(`%${opts.sender}%`, `%${opts.sender}%`, `%${opts.sender}%`);
  }

  if (opts.fromMe !== undefined) {
    conditions.push(`m.from_me = ?`);
    params.push(opts.fromMe ? 1 : 0);
  }

  if (opts.since) {
    conditions.push(`m.timestamp >= ?`);
    params.push(opts.since);
  }

  if (opts.until) {
    conditions.push(`m.timestamp <= ?`);
    params.push(opts.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const sql = `
    SELECT id, chat_jid, chat_name, sender_jid, sender_name, from_me, 
           timestamp, text_content, caption, message_type
    FROM messages m
    ${where}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `;

  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => ({
    ...r,
    from_me: r.from_me === 1,
  }));
}

export function getStats(): {
  total_messages: number;
  total_chats: number;
  total_contacts: number;
  oldest_message: number | null;
  newest_message: number | null;
} {
  const db = getDb();
  const stats = db
    .prepare(
      `
    SELECT 
      (SELECT COUNT(*) FROM messages) as total_messages,
      (SELECT COUNT(DISTINCT chat_jid) FROM messages) as total_chats,
      (SELECT COUNT(*) FROM contacts) as total_contacts,
      (SELECT MIN(timestamp) FROM messages) as oldest_message,
      (SELECT MAX(timestamp) FROM messages) as newest_message
  `,
    )
    .get() as any;

  return stats;
}

export function upsertContact(jid: string, name?: string, notify?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO contacts (jid, name, notify, updated_at)
    VALUES (?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      notify = COALESCE(excluded.notify, notify),
      updated_at = strftime('%s', 'now')
  `).run(jid, name || null, notify || null);
}

export function upsertChat(jid: string, name?: string, isGroup?: boolean): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO chats (jid, name, is_group, updated_at)
    VALUES (?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      is_group = COALESCE(excluded.is_group, is_group),
      updated_at = strftime('%s', 'now')
  `).run(jid, name || null, isGroup ? 1 : 0);
}

export function getContactName(jid: string): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT name, notify FROM contacts WHERE jid = ?`).get(jid) as any;
  return row?.name || row?.notify || null;
}

export function getChatName(jid: string): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT name FROM chats WHERE jid = ?`).get(jid) as any;
  return row?.name || null;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
