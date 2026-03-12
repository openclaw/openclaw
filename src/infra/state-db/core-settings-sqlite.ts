/**
 * SQLite adapter for the core_settings key-value table.
 *
 * Replaces scattered JSON settings files (voicewake.json, tts.json,
 * device.json, device-auth.json, restart-sentinel.json, update-check.json,
 * apns-registrations.json) with rows in a single core_settings table.
 *
 * Schema: core_settings(scope TEXT, key TEXT, value_json TEXT, updated_at INTEGER)
 * Primary key: (scope, key)
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "./connection.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setCoreSettingsDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetCoreSettingsDbForTest(): void {
  _dbOverride = null;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Get a single setting value. Returns the parsed JSON value, or null if not found.
 */
export function getCoreSettingFromDb<T = unknown>(scope: string, key = ""): T | null {
  const db = resolveDb();
  try {
    const row = db
      .prepare("SELECT value_json FROM core_settings WHERE scope = ? AND key = ?")
      .get(scope, key) as { value_json: string | null } | undefined;
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

/**
 * Get all settings for a scope. Returns a map of key → parsed value.
 */
export function getCoreSettingsByScope(scope: string): Map<string, unknown> {
  const db = resolveDb();
  const out = new Map<string, unknown>();
  try {
    const rows = db
      .prepare("SELECT key, value_json FROM core_settings WHERE scope = ?")
      .all(scope) as Array<{ key: string; value_json: string | null }>;
    for (const row of rows) {
      if (row.value_json != null) {
        try {
          out.set(row.key, JSON.parse(row.value_json));
        } catch {
          // skip unparseable rows
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return out;
    }
    throw err;
  }
  return out;
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Set a setting value (upsert). Pass any JSON-serializable value.
 */
export function setCoreSettingInDb(scope: string, key: string, value: unknown): void {
  const db = resolveDb();
  const json = JSON.stringify(value);
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(
      `INSERT INTO core_settings (scope, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(scope, key, json, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

/**
 * Delete a single setting.
 */
export function deleteCoreSettingFromDb(scope: string, key = ""): boolean {
  const db = resolveDb();
  try {
    const result = db
      .prepare("DELETE FROM core_settings WHERE scope = ? AND key = ?")
      .run(scope, key);
    return result.changes > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}

/**
 * Delete all settings for a scope.
 */
export function deleteCoreSettingsScopeFromDb(scope: string): number {
  const db = resolveDb();
  try {
    const result = db.prepare("DELETE FROM core_settings WHERE scope = ?").run(scope);
    return Number(result.changes);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return 0;
    }
    throw err;
  }
}
