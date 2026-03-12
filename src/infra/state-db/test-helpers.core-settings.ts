/**
 * Test helpers for core_settings SQLite tests.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { resetCoreSettingsDbForTest, setCoreSettingsDbForTest } from "./core-settings-sqlite.js";
import { runMigrations } from "./schema.js";

export function useCoreSettingsTestDb() {
  let db: DatabaseSync;

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setCoreSettingsDbForTest(db);
  });

  afterEach(() => {
    resetCoreSettingsDbForTest();
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
