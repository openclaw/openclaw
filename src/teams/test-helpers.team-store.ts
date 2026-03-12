/**
 * Test helpers for team store SQLite tests.
 *
 * Provides a per-test in-memory DB with op1_team_* tables.
 */
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { setTeamStoreDbForTest, resetTeamStoreDbForTest } from "./team-store-sqlite.js";

/**
 * Set up per-test in-memory SQLite DB for team store tests.
 * Call in a describe block.
 */
export function useTeamStoreTestDb() {
  let db: DatabaseSync;

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setTeamStoreDbForTest(db);
  });

  afterEach(() => {
    resetTeamStoreDbForTest();
    try {
      db?.close();
    } catch {
      // ignore
    }
  });

  return {
    getDb() {
      return db;
    },
  };
}
