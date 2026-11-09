import type { DatabaseSync } from "node:sqlite";

/**
 * Acquire native exclusion on the caller's settled, already-owned connection.
 * Leaves the transaction open; the caller owns settlement and final close.
 * This grants no application authority and does not change journal mode.
 */
export function beginSqliteConnectionExclusion(database: DatabaseSync): void {
  database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;"); // sqlite-allow-raw -- Native connection exclusion, retained until the caller closes.
}
