/**
 * SQLite adapter for the channel_dc_state table.
 *
 * Replaces discord/model-picker-preferences.json with rows in channel_dc_state.
 *
 * Schema: channel_dc_state(key TEXT, scope TEXT, value_json TEXT, updated_at INTEGER)
 * Primary key: (key, scope)
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "./connection.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setDcStateDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetDcStateDbForTest(): void {
  _dbOverride = null;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Read ────────────────────────────────────────────────────────────────────

export function getDcStateFromDb<T = unknown>(key: string, scope = ""): T | null {
  const db = resolveDb();
  try {
    const row = db
      .prepare("SELECT value_json FROM channel_dc_state WHERE key = ? AND scope = ?")
      .get(key, scope) as { value_json: string | null } | undefined;
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

export function setDcStateInDb(key: string, scope: string, value: unknown): void {
  const db = resolveDb();
  const json = JSON.stringify(value);
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(
      `INSERT INTO channel_dc_state (key, scope, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key, scope) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(key, scope, json, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

export function deleteDcStateFromDb(key: string, scope = ""): boolean {
  const db = resolveDb();
  try {
    const result = db
      .prepare("DELETE FROM channel_dc_state WHERE key = ? AND scope = ?")
      .run(key, scope);
    return Number(result.changes) > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}
