/**
 * Test helpers for auth_credentials SQLite tests.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import {
  resetAuthCredentialsDbForTest,
  setAuthCredentialsDbForTest,
} from "./auth-credentials-sqlite.js";
import { runMigrations } from "./schema.js";

export function useAuthCredentialsTestDb() {
  let db: DatabaseSync;

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setAuthCredentialsDbForTest(db);
  });

  afterEach(() => {
    resetAuthCredentialsDbForTest();
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
