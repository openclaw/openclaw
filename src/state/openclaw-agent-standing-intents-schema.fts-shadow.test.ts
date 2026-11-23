import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureOpenClawAgentStandingIntentsSchema } from "./openclaw-agent-standing-intents-schema.js";

type Database = ReturnType<typeof openNodeSqliteDatabase>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function tableNames(db: Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

/**
 * FTS5 keeps its shadow tables when the virtual table is gone. SQLite then refuses
 * to recreate the virtual table, because the shadow table already exists.
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
  // Drop only the virtual table; its FTS5 shadows stay behind as orphans.
  db.exec("DROP TABLE standing_intents_fts");
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

it("keeps orphaned FTS5 shadows when the virtual table is still present", () =>
  withOrphanedFtsShadows((db) => {
    db.exec("CREATE VIRTUAL TABLE standing_intents_fts USING fts5(trigger_keywords, content = 'standing_intents', content_rowid = 'intent_key', tokenize = 'unicode61 remove_diacritics 2')");
    const before = tableNames(db);
    expect(before).toContain("standing_intents_fts");
    expect(before).toContain("standing_intents_fts_data");

    ensureOpenClawAgentStandingIntentsSchema(db);

    const after = tableNames(db);
    expect(after).toContain("standing_intents_fts");
    expect(after).toContain("standing_intents_fts_data");
  }));
