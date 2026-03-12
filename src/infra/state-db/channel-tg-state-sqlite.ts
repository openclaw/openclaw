/**
 * SQLite adapter for the channel_tg_state table.
 *
 * Replaces per-account JSON files (update-offset-{acctId}.json, sticker-cache.json)
 * with rows in a single channel_tg_state table.
 *
 * Schema: channel_tg_state(account_id TEXT, key TEXT, value_json TEXT, updated_at INTEGER)
 * Primary key: (account_id, key)
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "./connection.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setTgStateDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetTgStateDbForTest(): void {
  _dbOverride = null;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Read ────────────────────────────────────────────────────────────────────

export function getTgStateFromDb<T = unknown>(accountId: string, key: string): T | null {
  const db = resolveDb();
  try {
    const row = db
      .prepare("SELECT value_json FROM channel_tg_state WHERE account_id = ? AND key = ?")
      .get(accountId, key) as { value_json: string | null } | undefined;
    if (!row || row.value_json == null) {
      return null;
    }
    return JSON.parse(row.value_json) as T;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

// ── Write ───────────────────────────────────────────────────────────────────

export function setTgStateInDb(accountId: string, key: string, value: unknown): void {
  const db = resolveDb();
  const json = JSON.stringify(value);
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(
      `INSERT INTO channel_tg_state (account_id, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(accountId, key, json, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

export function deleteTgStateFromDb(accountId: string, key: string): boolean {
  const db = resolveDb();
  try {
    const result = db
      .prepare("DELETE FROM channel_tg_state WHERE account_id = ? AND key = ?")
      .run(accountId, key);
    return Number(result.changes) > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}
