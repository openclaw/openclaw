/**
 * SQLite adapter for gateway config.
 *
 * Replaces:
 *   ~/.openclaw/openclaw.json → op1_config (singleton row, id=1)
 *
 * The table stores the raw JSON5 string exactly as-is so that all existing
 * parse/validate/env-var/include logic in src/config/io.ts is untouched.
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "./connection.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setConfigDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetConfigDbForTest(): void {
  _dbOverride = null;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Config read/write ────────────────────────────────────────────────────────

/** Returns the raw JSON5 string stored in op1_config, or null if not yet written. */
export function getConfigRawFromDb(): string | null {
  const db = resolveDb();
  try {
    const row = db.prepare("SELECT raw_json5 FROM op1_config WHERE id = 1").get() as
      | { raw_json5: unknown }
      | undefined;
    if (!row?.raw_json5) {
      return null;
    }
    // Guard: if the stored value is somehow not a string (e.g. Buffer from a
    // previous bug), convert it rather than returning garbage that crashes JSON5.parse.
    if (typeof row.raw_json5 !== "string") {
      return Buffer.isBuffer(row.raw_json5)
        ? row.raw_json5.toString("utf-8")
        : JSON.stringify(row.raw_json5);
    }
    return row.raw_json5;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

/** Upserts the raw JSON5 string into op1_config (singleton row id=1). */
export function setConfigRawInDb(raw: string): void {
  // Defensive guard: ensure we never write a non-string (e.g. Buffer) to the DB.
  // A Buffer passed to node:sqlite .run() gets serialized as {"0":123,"1":10,...}
  // which corrupts the config and crashes the gateway on next read.
  const safeRaw =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? (raw as Buffer).toString("utf-8")
        : String(raw);

  const db = resolveDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO op1_config (id, raw_json5, written_at)
     VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       raw_json5 = excluded.raw_json5,
       written_at = excluded.written_at`,
  ).run(safeRaw, now);
}
