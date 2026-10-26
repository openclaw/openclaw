import { channel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { admitStoreSearch } from "../infra/database-engine/adapters.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import type { SearchSchema, StoreSchema } from "../infra/database-engine/contract.js";
import { openEngineStore } from "../infra/database-engine/open.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../infra/sql-connection.js";
import { publishSqliteDatabaseSchemaChange } from "../infra/sqlite-database-admission.js";
import {
  agentEngineSchema,
  admitAgentEngineSearchExtensions,
  openAgentEngineStore,
} from "./openclaw-agent-db-engine.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterAll);
const textSchema = (
  name: string,
  table: string,
  field: string,
  identity: string,
): SearchSchema => ({
  text: { [name]: { table, fields: [field], postgres: { identity } } },
});
const text = textSchema("body", "memory_index_chunks", "text", "chunk_rowid");
const vector: SearchSchema = {
  vector: {
    chunks: {
      table: "memory_index_chunks_vec",
      alias: "v",
      rowShape: { id: "string" },
      postgres: {
        source: "memory_index_chunks",
        key: "id",
        embedding: "embedding",
        dimensions: 3,
      },
    },
  },
};

function captureStatements(run: () => void) {
  const statements: unknown[] = [];
  const observe = (event: unknown) => statements.push(event);
  const events = channel("openclaw.database.statement");
  events.subscribe(observe);
  try {
    run();
  } finally {
    events.unsubscribe(observe);
  }
  return statements;
}

it("leaves SQLite extension admission and statements unchanged", () => {
  const filename = path.join(dirs.make("sqlite-search-admission-"), "agent.sqlite");
  using db = openNodeSqliteDatabase(filename);
  db.exec("CREATE TABLE preserved (value BLOB); INSERT INTO preserved VALUES (X'001122ff')");
  const bytes = readFileSync(filename);
  const statements = captureStatements(() => {
    admitAgentEngineSearchExtensions(db, { "memory.text": text }, () => {
      throw new Error("SQLite must retain its own memory admission");
    });
  });
  expect(statements).toEqual([]);
  expect(readFileSync(filename)).toEqual(bytes);
});

describe.skipIf(!connection)("PostgreSQL agent-owned memory search admission", () => {
  let anchor: ReturnType<typeof openNodeSqliteDatabase>;
  let databasePath: string;
  let db: PostgresSqlConnection;
  const get = (sql: string, ...values: SQLInputValue[]) => db.prepare(sql).get(...values);
  const extensions = () =>
    String(get("SELECT search_extensions FROM openclaw_schema_meta")?.search_extensions);
  const opened: PostgresSqlConnection[] = [];
  const open = (selectedAnchor = anchor) =>
    withDatabaseEngineSelection(
      {
        effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
        postgres: { connection: connection!, schemaPrefix: "memory_admission_test" },
      },
      () => {
        const result = openAgentEngineStore(selectedAnchor, "main", databasePath);
        if (!isPostgresSqlConnection(result)) {
          throw new Error("Expected PostgreSQL agent store");
        }
        opened.push(result);
        return result;
      },
    );
  beforeAll(() => {
    expect(threadId, "Admission proof retains the suite's in-process descriptor").toBe(0);
    databasePath = path.join(dirs.make("pg-memory-admission-"), "agent.sqlite");
    anchor = openNodeSqliteDatabase(databasePath);
    db = withEngineStoreAdmission(open);
  });
  afterAll(() => {
    withEngineStoreAdmission(() => {
      try {
        if (db) {
          db.exec(`DROP SCHEMA "${getPostgresPhysicalFacts(db)!.namespace}" CASCADE`);
        }
      } finally {
        opened.forEach((item) => item.close());
        anchor?.close();
      }
    });
  });

  it("re-admits persisted memory extensions without DDL", () => {
    withEngineStoreAdmission(() => {
      expect(
        get(
          "SELECT to_jsonb(meta)->>'search_extensions' AS search_extensions FROM openclaw_schema_meta meta",
        ),
      ).toEqual({ search_extensions: null });
      const stages: string[] = [];
      const definitions = { "memory.text": text, "memory.vector": vector };
      admitAgentEngineSearchExtensions(db, definitions, (stage) => stages.push(stage));
      expect(stages).toEqual(["transaction", "commit"]);
      expect(
        get(
          "SELECT t.typname AS type, a.atttypmod AS dimensions FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid WHERE a.attrelid = 'memory_index_chunks_vec'::regclass AND a.attname = 'embedding'",
        ),
      ).toEqual({ type: "vector", dimensions: 3 });

      db.close();
      // Forget process-local admission to exercise the persisted extension definitions.
      publishSqliteDatabaseSchemaChange(anchor);
      const statements = captureStatements(() => {
        db = open();
        admitAgentEngineSearchExtensions(db, definitions, () => {
          throw new Error("Persisted extensions must already be admitted after reopen");
        });
        const rebound = admitStoreSearch(db, vector);
        expect(rebound.vector).not.toBeNull();
        expect(rebound.vectors.chunks?.postgres?.dimensions).toBe(3);
      }).flatMap((value) =>
        isRecord(value) && value.engine === "postgres" && typeof value.sql === "string"
          ? [value.sql]
          : [],
      );
      expect(statements.length).toBeGreaterThan(0);
      expect(
        statements.filter((sql) =>
          /\bCREATE\s+(?:SCHEMA|TABLE|INDEX|FUNCTION|TEXT\s+SEARCH)\b/i.test(sql),
        ),
      ).toEqual([]);
      expect(JSON.parse(extensions())).toEqual(definitions);
    });
  });

  it("does no SQL or write admission for 20 warm memory extension requests", () => {
    withEngineStoreAdmission(() => {
      const statements = captureStatements(() => {
        for (let index = 0; index < 20; index++) {
          admitAgentEngineSearchExtensions(db, { "memory.text": text }, () => {});
        }
      });
      expect(statements).toHaveLength(0);
      admitAgentEngineSearchExtensions(db, { "memory.text": text }, () => {
        throw new Error("An admitted search must not request write authority");
      });
    });
  });

  it("refuses a changed definition through the existing admission path", () => {
    withEngineStoreAdmission(() => {
      const stages: string[] = [];
      expect(() =>
        admitAgentEngineSearchExtensions(
          db,
          { "memory.text": textSchema("body", "memory_index_sources", "path", "id") },
          (stage) => stages.push(stage),
        ),
      ).toThrow(/Search extension memory.text changed/);
      expect(stages).toEqual(["transaction"]);
      expect(JSON.parse(extensions())["memory.text"]).toEqual(text);
    });
  });

  it("rolls back DDL and metadata after commit authority expires", () => {
    withEngineStoreAdmission(() => {
      expect(() =>
        admitAgentEngineSearchExtensions(
          db,
          { "memory.paths": textSchema("paths", "memory_index_sources", "path", "id") },
          (stage) => {
            if (stage === "commit") {
              throw new Error("Memory owner retired before commit");
            }
          },
        ),
      ).toThrow("Memory owner retired before commit");
      expect(extensions()).not.toContain("memory.paths");
      expect(
        get(
          "SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = 'memory_index_sources' AND column_name = 'openclaw_search'",
          getPostgresPhysicalFacts(db)!.namespace,
        ),
      ).toBeUndefined();
    });
  });

  it("locks first-use installation and shares its admission with another handle", () => {
    withEngineStoreAdmission(() => {
      using nextAnchor = openNodeSqliteDatabase(databasePath);
      const next = open(nextAnchor);
      try {
        expect(getPostgresPhysicalFacts(next)).toBe(getPostgresPhysicalFacts(db));
        const paths = { "memory.paths": textSchema("paths", "memory_index_sources", "path", "id") };
        const stages: string[] = [];
        const tryLock = () =>
          db.prepare("SELECT pg_try_advisory_xact_lock(?) AS locked").get(next.advisoryLockKey);
        admitAgentEngineSearchExtensions(next, paths, (stage) => {
          stages.push(stage);
          if (stage === "transaction") {
            expect(tryLock()).toEqual({ locked: 0 });
          }
        });
        expect(stages).toEqual(["transaction", "commit"]);
        expect(tryLock()).toEqual({ locked: 1 });
        // A second publication must consume the committed definition without reinstalling DDL.
        expect(
          captureStatements(() =>
            admitAgentEngineSearchExtensions(db, paths, () => {
              throw new Error("A second handle must reuse committed extension admission");
            }),
          ),
        ).toEqual([]);
        expect(JSON.parse(extensions())).toEqual({
          "memory.text": text,
          "memory.vector": vector,
          "memory.paths": textSchema("paths", "memory_index_sources", "path", "id"),
        });
      } finally {
        next.close();
      }
    });
  });
});

describe.skipIf(!connection)("PostgreSQL vector decoder migration", () => {
  it("preserves populated v31 rows and avoids repeated TOAST reads after migration", () => {
    withEngineStoreAdmission(() => {
      using anchor = openNodeSqliteDatabase(
        path.join(dirs.make("pg-vector-migration-"), "agent.sqlite"),
      );
      const opened: PostgresSqlConnection[] = [];
      const open = (schema: StoreSchema, existingVersion = false) => {
        const result = openEngineStore({
          anchor,
          schema,
          existingVersion,
          input: { connection: connection!, schemaPrefix: "vector_migration" },
          inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
          prepareAnchor() {},
          openSqlite() {
            throw new Error("Expected PostgreSQL");
          },
        });
        if (!isPostgresSqlConnection(result)) {
          throw new Error("Expected PostgreSQL");
        }
        opened.push(result);
        return result;
      };
      const predecessor: StoreSchema = {
        ...agentEngineSchema,
        ...agentEngineSchema.postgresMigrations!.find((step) => step.version === 32)!.fromSchema,
        version: 31,
        postgresVectorDecoderVersion: 1,
        postgresVectorSearchVersion: 1,
      };
      let db = open(predecessor);
      const namespace = getPostgresPhysicalFacts(db)!.namespace;
      try {
        const definition: SearchSchema = {
          vector: {
            chunks: {
              ...vector.vector!.chunks!,
              postgres: {
                ...vector.vector!.chunks!.postgres!,
                dimensions: 1536,
              },
            },
          },
        };
        db.runTransaction(() => {
          db.exec("INSERT INTO schema_meta VALUES ('primary', 'agent', 31, 'main', NULL, 1, 1)");
          admitStoreSearch(db, definition, { extension: "memory.vector" });
          // Incompressible, external bytes expose repeated detoasting in the old decoder.
          db.exec("ALTER TABLE memory_index_chunks ALTER COLUMN embedding SET STORAGE EXTERNAL");
          const bytes = Buffer.alloc(1536 * 8);
          for (let i = 0; i < 1536; i++) {
            bytes.writeDoubleLE(Math.sin(i + 1), i * 8);
          }
          db.prepare(`INSERT INTO memory_index_chunks
            (id, path, start_line, end_line, hash, model, text, embedding, updated_at)
            VALUES ('retained', 'memory/retained.md', 1, 1, 'hash', 'model', 'retained', ?, 1)`).run(
            bytes,
          );
        });
        // Storage policy is not sealed; reset it before reopening against generated DDL.
        db.exec("ALTER TABLE memory_index_chunks ALTER COLUMN embedding SET STORAGE EXTENDED");
        // v33 backfills derived bits; canonical tuple identities and vector bytes remain stable.
        const retained = () =>
          db
            .prepare(`SELECT c.xmin::text AS chunk_xmin, c.ctid::text AS chunk_ctid,
          encode(c.embedding, 'hex') AS canonical,
          encode(public.vector_send(v.embedding), 'hex') AS projection
          FROM memory_index_chunks c JOIN memory_index_chunks_vec v USING(id)`)
            .all();
        const before = retained();
        const decodeToastReads = () =>
          db.runTransaction(() => {
            // Backend-local relation counts exclude catalog planning and other connections.
            // Keep both samples in one transaction so pending counts cannot flush between them.
            const reads = () =>
              Number(
                db
                  .prepare(`SELECT pg_stat_get_xact_blocks_fetched(reltoastrelid) AS reads
                    FROM pg_class WHERE oid = 'memory_index_chunks'::regclass`)
                  .get()?.reads,
              );
            const start = reads();
            db.prepare(
              "SELECT public.vector_send(openclaw_vector(embedding, 1536)) FROM memory_index_chunks",
            ).get();
            return reads() - start;
          });
        // The historical decoder must still trip the repeated-detoasting bound.
        expect(decodeToastReads()).toBeGreaterThan(100);
        const project = (values: readonly number[], dimensions = values.length) => {
          const bytes = Buffer.alloc(values.length * 8);
          values.forEach((value, i) => bytes.writeDoubleLE(value, i * 8));
          try {
            return db
              .prepare("SELECT encode(public.vector_send(openclaw_vector(?, ?)), 'hex') AS bytes")
              .get(bytes, dimensions);
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error)) {
              throw error;
            }
            return { name: error.name, code: error.code, message: error.message };
          }
        };
        const edges = [
          [-0, 0, Number.MIN_VALUE],
          [-Number.MIN_VALUE, 2 ** -150, -(2 ** -150)],
          [1 + 2 ** -24, 1 + 3 * 2 ** -24, 3.4028234663852886e38],
          [Number.NaN, Number.MAX_VALUE],
          [Number.MAX_VALUE, Number.NaN],
          [Infinity],
          [-Infinity],
          [],
        ];
        const edgeResults = edges.map((values) => project(values));
        const wrongDimension = project([1, 2], 3);
        const functionOid = () =>
          db.prepare("SELECT 'openclaw_vector(bytea,integer)'::regprocedure::oid AS oid").get();
        const oid = functionOid();
        db.close();
        publishSqliteDatabaseSchemaChange(anchor);
        // Inspection by the new build must still render the exact historical decoder.
        db = open(agentEngineSchema, true);
        expect(getPostgresPhysicalFacts(db)?.version).toBe(31);
        db.close();
        publishSqliteDatabaseSchemaChange(anchor);
        db = open(agentEngineSchema);
        expect(getPostgresPhysicalFacts(db)?.version).toBe(agentEngineSchema.version);
        expect(retained()).toEqual(before);
        expect(functionOid()).toEqual(oid);
        expect(edges.map((values) => project(values))).toEqual(edgeResults);
        expect(project([1, 2], 3)).toEqual(wrongDimension);
        expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
          schema_version: agentEngineSchema.version,
        });
        // Exercise both warm and cold function plans: EXPLAIN also counts catalog reads.
        for (const cold of [false, true]) {
          if (cold) {
            db.close();
            db = open(agentEngineSchema);
          }
          const reads = decodeToastReads();
          expect(reads).toBeGreaterThan(0);
          expect(reads).toBeLessThan(100);
        }
        expect(retained()).toEqual(before);
      } finally {
        if (db.isOpen) {
          db.exec(`DROP SCHEMA "${namespace}" CASCADE`);
        }
        opened.forEach((item) => item.close());
      }
    });
  });
});
