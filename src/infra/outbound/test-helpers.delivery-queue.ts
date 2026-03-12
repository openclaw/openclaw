/**
 * Test helpers for delivery queue SQLite tests.
 *
 * Provides a per-test in-memory DB with delivery_queue table.
 */
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { runMigrations } from "../state-db/schema.js";
import { setDeliveryQueueDbForTest, resetDeliveryQueueDbForTest } from "./delivery-queue-sqlite.js";

/**
 * Set up per-test in-memory SQLite DB for delivery queue tests.
 * Call in a describe block.
 */
export function useDeliveryQueueTestDb() {
  let db: DatabaseSync;

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setDeliveryQueueDbForTest(db);
  });

  afterEach(() => {
    resetDeliveryQueueDbForTest();
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
