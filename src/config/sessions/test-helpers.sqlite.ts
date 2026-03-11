import type { DatabaseSync } from "node:sqlite";
/**
 * Test helpers for session store SQLite tests.
 *
 * Provides a per-test in-memory DB with session_entries table.
 */
import { beforeEach, afterEach } from "vitest";
import { runMigrations } from "../../infra/state-db/schema.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import {
  setSessionStoreDbForTest,
  resetSessionStoreDbForTest,
  saveSessionEntriesToDb,
  extractAgentIdFromStorePath,
} from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

/**
 * Set up per-test in-memory SQLite DB for session store tests.
 * Call in a describe block; returns a handle to seed data.
 */
export function useSessionStoreTestDb() {
  let db: DatabaseSync;

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setSessionStoreDbForTest(db);
  });

  afterEach(() => {
    resetSessionStoreDbForTest();
    try {
      db?.close();
    } catch {
      // ignore
    }
  });

  return {
    /** Seed session data for a storePath (extracts agentId from path). */
    seed(storePath: string, store: Record<string, SessionEntry>) {
      const agentId = extractAgentIdFromStorePath(storePath);
      saveSessionEntriesToDb(agentId, store, db);
    },
    /** Get the test DB instance. */
    getDb() {
      return db;
    },
  };
}
