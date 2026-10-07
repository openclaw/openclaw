/**
 * The v19 delegated-execution-ownership migration is the direct successor of the
 * v18 schema. Only a database that is exactly at v18 and lacks the registry may
 * be asked to run it: earlier schema families have their own positive-shape
 * detection, and legacy/pre-v2 databases are rebuilt wholesale, so neither may
 * receive a synthetic v19 migration.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { detectOpenClawStateDatabaseSchemaMigrationsFromDatabase } from "./openclaw-state-db-schema-repair.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Migration = { kind: string };

function openDatabase(): { db: DatabaseSync; pathname: string } {
  const pathname = path.join(tempDirs.make("v19-detection-"), "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  return { db: new DatabaseSync(pathname), pathname };
}

function detectsV19Migration(db: DatabaseSync, pathname: string): boolean {
  const migrations = detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(
    db,
    pathname,
  ) as Migration[];
  return migrations.some((migration) => migration.kind === "delegated-execution-ownership-v19");
}

describe("delegated execution ownership v19 migration detection", () => {
  it("detects v19 for a v18 database that lacks the ownership registry", () => {
    const { db, pathname } = openDatabase();
    try {
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec(
        "DROP TABLE IF EXISTS delegated_execution_ownership; " +
          "DROP TABLE IF EXISTS delegated_execution_ownership_events; " +
          "PRAGMA user_version = 18;",
      );
      expect(detectsV19Migration(db, pathname)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("does not detect v19 for a v18 database that already has the registry", () => {
    const { db, pathname } = openDatabase();
    try {
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec("PRAGMA user_version = 18;");
      expect(detectsV19Migration(db, pathname)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("does not spuriously detect v19 for a legacy pre-v2 database", () => {
    const { db, pathname } = openDatabase();
    try {
      db.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT,
          app_version TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO schema_meta (
          meta_key, role, schema_version, created_at, updated_at
        ) VALUES ('primary', 'global', 1, 10, 10);
      `);
      expect(detectsV19Migration(db, pathname)).toBe(false);
    } finally {
      db.close();
    }
  });
});
