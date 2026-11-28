import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureOpenClawAgentStandingIntentsSchema } from "./openclaw-agent-standing-intents-schema.js";

type Database = ReturnType<typeof openNodeSqliteDatabase>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const STANDING_INTENTS_FTS_CREATE = `CREATE VIRTUAL TABLE standing_intents_fts USING fts5(
  trigger_keywords,
  content = 'standing_intents',
  content_rowid = 'intent_key',
  tokenize = 'unicode61 remove_diacritics 2'
)`;

/**
 * The shadow tables SQLite creates for an FTS5 virtual table. Recreating them as
 * standalone tables is what reproduces the orphaned-shadow state: the virtual table
 * is gone, its shadows are still in the catalog, and SQLite refuses to recreate the
 * virtual table because the shadow name is taken.
 */
const ORPHANED_SHADOW_TABLES = [
  `CREATE TABLE 'standing_intents_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID`,
  `CREATE TABLE 'standing_intents_fts_data'(id INTEGER PRIMARY KEY, block BLOB)`,
  `CREATE TABLE 'standing_intents_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)`,
  `CREATE TABLE 'standing_intents_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID`,
];

function tableNames(db: Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function seedStandingIntent(db: Database): void {
  db.prepare(
    `INSERT INTO standing_intents (
       intent_key, id, description, trigger_keywords, status, expires_at, max_fires, created_at
     ) VALUES (1, 'intent-1', 'rebuild probe', 'rebuildprobe', 'armed', 9999999999999, 1, 1)`,
  ).run();
}

/**
 * FTS5 keeps its shadow tables when the virtual table is gone. SQLite then refuses
 * to recreate the virtual table, because the shadow table already exists.
 *
 * `DROP TABLE` on an FTS5 virtual table removes its shadows as well, so the orphan
 * state is built explicitly: drop the virtual table, then re-create the shadow
 * tables on their own.
 */
function withOrphanedFtsShadows(run: (db: Database, databasePath: string) => void) {
  const tempDir = tempDirs.make("openclaw-standing-intents-fts-shadow-");
  const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
  using db = openNodeSqliteDatabase(databasePath);
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
  db.prepare(
    `INSERT INTO schema_meta (
      meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
    ) VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)`,
  ).run(OPENCLAW_AGENT_SCHEMA_VERSION);
  // Seed content before the virtual table is dropped: the FTS5 triggers write into
  // the index and would fail once the virtual table is gone.
  seedStandingIntent(db);
  db.exec("DROP TABLE standing_intents_fts");
  for (const shadow of ORPHANED_SHADOW_TABLES) {
    db.exec(`${shadow};`);
  }
  run(db, databasePath);
}

it("recreates the standing-intents FTS table when its shadow tables were left behind", () =>
  withOrphanedFtsShadows((db) => {
    const before = tableNames(db);
    expect(before).toContain("standing_intents_fts_data");
    expect(before).not.toContain("standing_intents_fts");

    ensureOpenClawAgentStandingIntentsSchema(db);

    const after = tableNames(db);
    expect(after).toContain("standing_intents_fts");
    expect(after).toContain("standing_intents_fts_data");
  }));

it("reproduces the orphan-shadow failure without the cleanup", () =>
  withOrphanedFtsShadows((db) => {
    expect(() => db.exec(STANDING_INTENTS_FTS_CREATE)).toThrow(/shadow table/);
  }));

it("rebuilds the standing-intents FTS index after dropping orphaned shadows", () =>
  withOrphanedFtsShadows((db) => {
    ensureOpenClawAgentStandingIntentsSchema(db);

    const hits = db
      .prepare("SELECT rowid FROM standing_intents_fts WHERE standing_intents_fts MATCH ?")
      .all("rebuildprobe");
    expect(hits.map((row) => row.rowid)).toEqual([1]);
  }));

it("keeps the FTS5 shadows when the virtual table is still present", () =>
  withOrphanedFtsShadows((db) => {
    // Restore the coherent state: the shadows belong to a live virtual table again.
    db.exec("DROP TABLE standing_intents_fts_data");
    db.exec("DROP TABLE standing_intents_fts_idx");
    db.exec("DROP TABLE standing_intents_fts_docsize");
    db.exec("DROP TABLE standing_intents_fts_config");
    db.exec(STANDING_INTENTS_FTS_CREATE);
    const before = tableNames(db);
    expect(before).toContain("standing_intents_fts");
    expect(before).toContain("standing_intents_fts_data");

    ensureOpenClawAgentStandingIntentsSchema(db);

    const after = tableNames(db);
    expect(after).toContain("standing_intents_fts");
    expect(after).toContain("standing_intents_fts_data");
  }));
