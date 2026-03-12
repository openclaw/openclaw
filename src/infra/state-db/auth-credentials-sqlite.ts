/**
 * SQLite adapter for the auth_credentials table.
 *
 * Replaces credentials/github-copilot.token.json and similar auth credential files
 * with rows in the auth_credentials table.
 *
 * Schema: auth_credentials(provider TEXT, account_id TEXT, credentials_json TEXT,
 *                          expires_at INTEGER, updated_at INTEGER)
 * Primary key: (provider, account_id)
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "./connection.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setAuthCredentialsDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetAuthCredentialsDbForTest(): void {
  _dbOverride = null;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Read ────────────────────────────────────────────────────────────────────

export function getAuthCredentialsFromDb<T = unknown>(provider: string, accountId = ""): T | null {
  const db = resolveDb();
  try {
    const row = db
      .prepare(
        "SELECT credentials_json FROM auth_credentials WHERE provider = ? AND account_id = ?",
      )
      .get(provider, accountId) as { credentials_json: string | null } | undefined;
    if (!row || row.credentials_json == null) {
      return null;
    }
    return JSON.parse(row.credentials_json) as T;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

// ── Write ───────────────────────────────────────────────────────────────────

export function setAuthCredentialsInDb(
  provider: string,
  accountId: string,
  credentials: unknown,
  expiresAt?: number | null,
): void {
  const db = resolveDb();
  const json = JSON.stringify(credentials);
  const now = Math.floor(Date.now() / 1000);
  const expires = expiresAt != null ? Math.floor(expiresAt / 1000) : null;
  try {
    db.prepare(
      `INSERT INTO auth_credentials (provider, account_id, credentials_json, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider, account_id) DO UPDATE SET
         credentials_json = excluded.credentials_json,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    ).run(provider, accountId, json, expires, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

export function deleteAuthCredentialsFromDb(provider: string, accountId = ""): boolean {
  const db = resolveDb();
  try {
    const result = db
      .prepare("DELETE FROM auth_credentials WHERE provider = ? AND account_id = ?")
      .run(provider, accountId);
    return Number(result.changes) > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}
