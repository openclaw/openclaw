import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { agentEngineSchema } from "../../state/openclaw-agent-db-engine.js";
import { getOpenClawAgentMigrationSchema } from "../../state/openclaw-agent-schema-history.js";
import {
  expectVersion,
  migrationFixture,
  seedVersion,
} from "../../state/schema-migration.test-support.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import type { EngineConnection } from "../sql-connection.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import { openPostgresEngineTestStore } from "./engine-store.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
const version = 36;
const indexNames = [
  "idx_memory_index_sources_basename",
  "idx_memory_index_sources_exact_path",
  "idx_memory_index_sources_stem",
];

function migration() {
  const step = agentEngineSchema.postgresMigrations?.find((item) => item.version === version);
  if (!step) {
    throw new Error("Missing agent memory-path migration");
  }
  return step;
}

function seedMemory(db: EngineConnection): void {
  db.prepare(
    `INSERT INTO memory_index_sources (id, path, source, hash, mtime, size)
     VALUES (1, ?, 'memory', 'source-hash', 12, 34)`,
  ).run("./Memory\\Cafe\u0301.md");
  db.prepare(
    `INSERT INTO memory_index_chunks
       (chunk_rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (1, 'chunk', ?, 'memory', 2, 3, 'chunk-hash', 'synthetic', 'preserved body', ?, 56)`,
  ).run("./Memory\\Cafe\u0301.md", new Uint8Array([0, 255, 1]));
}

function memoryRows(db: EngineConnection) {
  return {
    sources: db.prepare("SELECT * FROM memory_index_sources ORDER BY id").all(),
    chunks: db.prepare("SELECT * FROM memory_index_chunks ORDER BY chunk_rowid").all(),
  };
}

function indexes(db: PostgresSyncConnection) {
  return db
    .prepare(
      `SELECT c.relname AS name, c.oid::text AS oid, pg_get_indexdef(c.oid) AS definition
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE n.nspname = ? ORDER BY c.relname`,
    )
    .all(db.schema);
}

it("reconstructs the byte-identical PostgreSQL schema-35 predecessor", () => {
  // Frozen from main a4cfee8af58a, before memory path indexing existed.
  expect(createHash("sha256").update(migration().fromSchema.postgres).digest("hex")).toBe(
    "4d1fc7b70e14edbb5ce281cc15c29e6726d6e2105088c3337ac5a2762f4a305b",
  );
});

const withSqliteFixture = migrationFixture({
  predecessor: version - 1,
  target: version,
  scope: ["schema_meta"],
  seed(database) {
    database.exec(getOpenClawAgentMigrationSchema(version - 1));
    seedVersion(database, version - 1);
    seedMemory(database);
  },
});

it("advances SQLite metadata without changing schema or retained memory", async () => {
  await withSqliteFixture("memory-path-migration.sqlite", async ({ database, migrate }) => {
    const schema = () =>
      database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all();
    const beforeSchema = schema();
    const beforeRows = memoryRows(database);
    await migrate();
    expectVersion(database, version);
    expect(schema()).toEqual(beforeSchema);
    expect(memoryRows(database)).toEqual(beforeRows);
    await migrate();
    expect(schema()).toEqual(beforeSchema);
    expect(memoryRows(database)).toEqual(beforeRows);
  });
});

describe.skipIf(!connection)("PostgreSQL memory path index migration", () => {
  it("adds only the three derived indexes and preserves rows and every existing index", () => {
    withEngineStoreAdmission(() => {
      const step = migration();
      const target: StoreSchema = {
        ...agentEngineSchema,
        ...step.schema,
        version,
        postgresMigrations: agentEngineSchema.postgresMigrations?.filter(
          (item) => item.version <= version,
        ),
      };
      const source: StoreSchema = {
        ...target,
        ...step.fromSchema,
        version: version - 1,
        postgresMigrations: [],
      };
      using anchor = openNodeSqliteDatabase(
        path.join(dirs.make("pg-memory-path-migration-"), "anchor.sqlite"),
      );
      const opened: PostgresSyncConnection[] = [];
      const open = (schema: StoreSchema) => {
        const db = openPostgresEngineTestStore({
          anchor,
          schema,
          input: { connection: connection!, schemaPrefix: "memory_path_migration" },
        });
        if (!(db instanceof PostgresSyncConnection)) {
          throw new Error("Expected PostgreSQL connection");
        }
        opened.push(db);
        return db;
      };
      try {
        const original = open(source);
        original.runTransaction(() => {
          original
            .prepare(
              `INSERT INTO schema_meta
             (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
             VALUES ('primary', 'agent', 35, 'main', 'migration-fixture', 0, 0)`,
            )
            .run();
          seedMemory(original);
        });
        const beforeRows = memoryRows(original);
        const beforeIndexes = indexes(original);
        const isMemoryPathIndex = (index: (typeof beforeIndexes)[number]) =>
          indexNames.some((name) => index.name === name);
        expect(beforeIndexes.filter(isMemoryPathIndex)).toEqual([]);
        publishSqliteDatabaseSchemaChange(anchor);
        const upgraded = open(target);
        expect(
          upgraded.prepare("SELECT version FROM openclaw_schema_meta WHERE store = 'agent'").get(),
        ).toEqual({ version });
        expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
          schema_version: version,
        });
        expect(memoryRows(upgraded)).toEqual(beforeRows);
        const afterIndexes = indexes(upgraded);
        expect(afterIndexes.filter((index) => !isMemoryPathIndex(index))).toEqual(beforeIndexes);
        expect(afterIndexes.filter(isMemoryPathIndex)).toEqual(
          indexNames.map((name) =>
            expect.objectContaining({ name, definition: expect.stringContaining("USING btree") }),
          ),
        );
        publishSqliteDatabaseSchemaChange(anchor);
        const statements: string[] = [];
        const observe = (event: unknown) => {
          if (isRecord(event) && event.engine === "postgres" && typeof event.sql === "string") {
            statements.push(event.sql);
          }
        };
        const observation = channel("openclaw.database.statement");
        observation.subscribe(observe);
        try {
          const reopened = open(target);
          expect(indexes(reopened)).toEqual(afterIndexes);
          expect(memoryRows(reopened)).toEqual(beforeRows);
          expect(statements.filter((sql) => /^\s*(?:CREATE|ALTER|DROP|DO)\b/iu.test(sql))).toEqual(
            [],
          );
        } finally {
          observation.unsubscribe(observe);
        }
        publishSqliteDatabaseSchemaChange(anchor);
        const current = open(agentEngineSchema);
        expect(
          current.prepare("SELECT version FROM openclaw_schema_meta WHERE store = 'agent'").get(),
        ).toEqual({ version: agentEngineSchema.version });
        expect(current.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
          schema_version: agentEngineSchema.version,
        });
        expect(memoryRows(current)).toEqual(beforeRows);
        const retainedIndexNames = new Set(afterIndexes.map((index) => index.name));
        expect(indexes(current).filter((index) => retainedIndexNames.has(index.name))).toEqual(
          afterIndexes,
        );
        expect(
          current.prepare("SELECT * FROM session_transcript_cold_archive_chunks").all(),
        ).toEqual([]);
      } finally {
        const last = opened.at(-1);
        try {
          last?.exec(`DROP SCHEMA "${last.schema}" CASCADE`);
        } finally {
          opened.forEach((db) => db.close());
        }
      }
    });
  });
});
