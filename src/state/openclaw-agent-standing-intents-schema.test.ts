import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ensureMemoryChunkProvenance,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
} from "../../packages/memory-host-sdk/src/host/memory-schema-provenance.js";
import { MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE } from "../../packages/memory-host-sdk/src/host/memory-schema-recall.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureOpenClawAgentStandingIntentsSchema } from "./openclaw-agent-standing-intents-schema.js";

type Database = ReturnType<typeof openNodeSqliteDatabase>;

const STANDING_CREATOR_COLUMN =
  "  creator_sender TEXT CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0),\n";

function removeSchemaSection(startTable: string, endTable: string): string {
  const schema = OPENCLAW_AGENT_SCHEMA_SQL;
  const startMarker = `CREATE TABLE IF NOT EXISTS ${startTable} (`;
  const endMarker = `CREATE TABLE IF NOT EXISTS ${endTable} (`;
  const start = schema.indexOf(startMarker);
  const end = schema.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`schema markers missing in test fixture: ${startMarker}`);
  }
  return `${schema.slice(0, start)}${schema.slice(end)}`;
}

function expectAccepted(db: Database, databasePath: string) {
  expect(() =>
    ensureOpenClawAgentDatabaseSchema(db, { agentId: "main", path: databasePath }),
  ).not.toThrow();
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
  });
}
const expectRow = (db: Database, sql: string, expected: unknown) =>
  expect(db.prepare(sql).get()).toEqual(expected);
function table(db: Database, name: string) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
}
function columnNames(db: Database, name: string) {
  return db
    .prepare(`SELECT name FROM pragma_table_info('${name}')`)
    .all()
    .map((row) => row.name);
}
function schemaWithoutStandingIntentCreator(): string {
  if (!OPENCLAW_AGENT_SCHEMA_SQL.includes(STANDING_CREATOR_COLUMN)) {
    throw new Error("standing-intent creator column missing in test fixture");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.replace(STANDING_CREATOR_COLUMN, "");
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function withDatabase(schema: string, run: (db: Database, databasePath: string) => void) {
  const tempDir = tempDirs.make("openclaw-memory-schema-");
  const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
  using db = openNodeSqliteDatabase(databasePath);
  db.exec(schema);
  db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
  db.prepare(
    `INSERT INTO schema_meta (
          meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
        ) VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)`,
  ).run(OPENCLAW_AGENT_SCHEMA_VERSION);
  run(db, databasePath);
}

it.each(["tables", "creator"] as const)("lazily repairs missing %s idempotently", (missing) =>
  withDatabase(
    missing === "tables"
      ? removeSchemaSection("standing_intents", "session_transcript_index_state")
      : schemaWithoutStandingIntentCreator(),
    (db, databasePath) => {
      expectAccepted(db, databasePath);
      if (missing === "tables") {
        expect(table(db, "standing_intents")).toBeUndefined();
      } else {
        expect(columnNames(db, "standing_intents")).not.toContain("creator_sender");
      }

      ensureOpenClawAgentStandingIntentsSchema(db);
      ensureOpenClawAgentStandingIntentsSchema(db);

      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('standing_intents', 'standing_intents_fts') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "standing_intents" }, { name: "standing_intents_fts" }]);
      expect(
        db
          .prepare(
            "SELECT name, type, pk FROM pragma_table_info('standing_intents') WHERE name IN ('id', 'intent_key') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "id", type: "TEXT", pk: 0 },
        { name: "intent_key", type: "INTEGER", pk: 1 },
      ]);
      expect(columnNames(db, "standing_intents")).toContain("creator_sender");
      expectAccepted(db, databasePath);
    },
  ),
);

it("accepts current-version databases before the provenance lazy ensure", () =>
  withDatabase(
    removeSchemaSection("memory_index_chunk_provenance", "memory_embedding_cache"),
    (db, databasePath) => {
      expectAccepted(db, databasePath);
      expect(table(db, MEMORY_INDEX_CHUNK_PROVENANCE_TABLE)).toBeUndefined();

      db.exec("BEGIN IMMEDIATE");
      ensureMemoryChunkProvenance(db);
      db.exec("ROLLBACK");
      expect(table(db, MEMORY_INDEX_CHUNK_PROVENANCE_TABLE)).toBeUndefined();

      ensureMemoryChunkProvenance(db);
      ensureMemoryChunkProvenance(db);

      expectAccepted(db, databasePath);

      expect(table(db, MEMORY_INDEX_CHUNK_PROVENANCE_TABLE)).toBeDefined();
    },
  ));

it("migrates unreleased inline chunk metadata into rollback-safe storage", () =>
  withDatabase(
    `${removeSchemaSection("memory_index_chunk_recall_metadata", "memory_index_chunk_provenance")}
        ALTER TABLE memory_index_chunks ADD COLUMN importance INTEGER
          CHECK (importance IS NULL OR importance BETWEEN 1 AND 10);
        ALTER TABLE memory_index_chunks ADD COLUMN triggers TEXT;
        ALTER TABLE memory_index_chunks ADD COLUMN project_key TEXT;
        CREATE TRIGGER memory_index_chunk_provenance_after_insert
        AFTER INSERT ON memory_index_chunks
        BEGIN
          INSERT OR IGNORE INTO memory_index_chunk_provenance (
            chunk_id, origin_class, session_kind, observed_at
          ) VALUES (NEW.id, 'agent', 'unknown', NEW.updated_at);
        END;
        INSERT INTO memory_index_chunks (
          id, path, source, start_line, end_line, hash, model, text, embedding,
          updated_at, importance, triggers, project_key
        ) VALUES (
          'sentinel', 'MEMORY.md', 'memory', 1, 1, 'hash', 'model', 'body', X'',
          42, 9, 'when testing rollback', 'project/key'
        );
      `,
    (db, databasePath) => {
      expectAccepted(db, databasePath);
      expectRow(
        db,
        `SELECT importance, triggers, project_key
             FROM ${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE}
             WHERE chunk_id = 'sentinel'`,
        {
          importance: 9,
          triggers: "when testing rollback",
          project_key: "project/key",
        },
      );
      expectRow(
        db,
        "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'memory_index_chunk_provenance_after_insert'",
        undefined,
      );
      expectRow(db, "SELECT origin_class FROM memory_index_chunk_provenance", {
        origin_class: "agent",
      });
    },
  ));
