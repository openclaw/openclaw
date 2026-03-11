/**
 * State DB barrel exports.
 *
 * Single import point: import { initStateDb, getStateDb } from "../infra/state-db/index.js"
 */
import type { DatabaseSync } from "node:sqlite";
import { closeStateDb, getStateDb, getStateDbPath, resetStateDbCache } from "./connection.js";
import { checkStateDbIntegrity } from "./integrity.js";
import { runRetention } from "./retention.js";
import { getSchemaVersion, getTableRowCount, listTables, runMigrations } from "./schema.js";

export {
  closeStateDb,
  getStateDb,
  getStateDbPath,
  resetStateDbCache,
  checkStateDbIntegrity,
  runRetention,
  runMigrations,
  getSchemaVersion,
  listTables,
  getTableRowCount,
};

/**
 * Initialize the state DB: check integrity → open → migrate.
 *
 * If integrity check fails, the corrupt DB is renamed and a fresh
 * empty DB is created (no JSON fallback — see recovery plan).
 *
 * Returns the DatabaseSync instance.
 */
export function initStateDb(env: NodeJS.ProcessEnv = process.env): DatabaseSync {
  const dbPath = getStateDbPath(env);
  const integrity = checkStateDbIntegrity(dbPath);

  if (!integrity.ok) {
    // Corrupt DB was renamed by integrity check.
    // Log the issue — a fresh DB will be created by getStateDb().
    console.error(
      `[state-db] Corrupt database detected and renamed. ${integrity.error ?? ""}. Starting with empty state.`,
    );
    // Reset cached singleton so getStateDb() creates a new file
    resetStateDbCache();
  }

  const db = getStateDb(env);
  runMigrations(db);
  return db;
}
