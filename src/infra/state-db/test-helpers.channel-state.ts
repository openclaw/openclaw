/**
 * Test helpers for channel state SQLite tests (telegram + discord).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { resetDcStateDbForTest, setDcStateDbForTest } from "./channel-dc-state-sqlite.js";
import { resetTgStateDbForTest, setTgStateDbForTest } from "./channel-tg-state-sqlite.js";
import { runMigrations } from "./schema.js";

export function useChannelStateTestDb() {
  let db: DatabaseSync;

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setTgStateDbForTest(db);
    setDcStateDbForTest(db);
  });

  afterEach(() => {
    resetTgStateDbForTest();
    resetDcStateDbForTest();
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
