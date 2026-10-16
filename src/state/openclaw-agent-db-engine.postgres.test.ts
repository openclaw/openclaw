import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { admitStoreSearch } from "../infra/database-engine/adapters.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import type { SearchSchema } from "../infra/database-engine/contract.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../infra/sql-connection.js";
import { publishSqliteDatabaseSchemaChange } from "../infra/sqlite-database-admission.js";
import {
  admitAgentEngineSearchExtensions,
  openAgentEngineStore,
} from "./openclaw-agent-db-engine.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterAll);
const text: SearchSchema = {
  text: {
    body: {
      table: "memory_index_chunks",
      fields: ["text"],
      postgres: { identity: "chunk_rowid" },
    },
  },
};
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

it("leaves SQLite extension admission and statements unchanged", () => {
  using db = openNodeSqliteDatabase(":memory:");
  const statements: unknown[] = [];
  const observe = (event: unknown) => statements.push(event);
  const events = channel("openclaw.database.statement");
  events.subscribe(observe);
  try {
    admitAgentEngineSearchExtensions(db, { "memory.text": text }, () => {
      throw new Error("SQLite must retain its own memory admission");
    });
  } finally {
    events.unsubscribe(observe);
  }
  expect(statements).toEqual([]);
});

describe.skipIf(!connection)("PostgreSQL agent-owned memory search admission", () => {
  let anchor: ReturnType<typeof openNodeSqliteDatabase>;
  let databasePath: string;
  let db: PostgresSqlConnection;
  const opened: PostgresSqlConnection[] = [];
  const open = () =>
    withDatabaseEngineSelection(
      {
        effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
        postgres: { connection: connection!, schemaPrefix: "memory_admission_test" },
      },
      () => {
        const result = openAgentEngineStore(anchor, "main", databasePath);
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

  it("admits enabled memory definitions with model dimensions and re-admits them on restart", () => {
    withEngineStoreAdmission(() => {
      expect(
        db
          .prepare(
            "SELECT to_jsonb(meta)->>'search_extensions' AS search_extensions FROM openclaw_schema_meta meta",
          )
          .get(),
      ).toEqual({ search_extensions: null });
      const stages: string[] = [];
      admitAgentEngineSearchExtensions(
        db,
        { "memory.text": text, "memory.vector": vector },
        (stage) => {
          stages.push(stage);
        },
      );
      expect(stages).toEqual(["transaction", "commit"]);
      expect(
        db
          .prepare(
            "SELECT t.typname AS type, a.atttypmod AS dimensions FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid WHERE a.attrelid = 'memory_index_chunks_vec'::regclass AND a.attname = 'embedding'",
          )
          .get(),
      ).toEqual({ type: "vector", dimensions: 3 });

      const statements: string[] = [];
      const events = channel("openclaw.database.statement");
      const observe = (value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "engine" in value &&
          value.engine === "postgres" &&
          "sql" in value &&
          typeof value.sql === "string"
        ) {
          statements.push(value.sql);
        }
      };
      const previous = db;
      previous.close();
      // Forget process-local admission to exercise the persisted extension definitions.
      publishSqliteDatabaseSchemaChange(anchor);
      events.subscribe(observe);
      try {
        db = open();
        const rebound = admitStoreSearch(db, vector);
        expect(rebound.vector).not.toBeNull();
        expect(rebound.vectors.chunks?.postgres?.dimensions).toBe(3);
      } finally {
        events.unsubscribe(observe);
      }
      expect(statements.length).toBeGreaterThan(0);
      expect(
        statements.filter((sql) =>
          /\bCREATE\s+(?:SCHEMA|TABLE|INDEX|FUNCTION|TEXT\s+SEARCH)\b/i.test(sql),
        ),
      ).toEqual([]);
      expect(
        JSON.parse(
          String(
            db.prepare("SELECT search_extensions FROM openclaw_schema_meta").get()
              ?.search_extensions,
          ),
        ),
      ).toEqual({ "memory.text": text, "memory.vector": vector });
    });
  });

  it("rolls back derived DDL and metadata when live commit authority expires", () => {
    withEngineStoreAdmission(() => {
      expect(() =>
        admitAgentEngineSearchExtensions(
          db,
          {
            "memory.paths": {
              text: {
                paths: {
                  table: "memory_index_sources",
                  fields: ["path"],
                  postgres: { identity: "id" },
                },
              },
            },
          },
          (stage) => {
            if (stage === "commit") {
              throw new Error("Memory owner retired before commit");
            }
          },
        ),
      ).toThrow("Memory owner retired before commit");
      expect(
        String(
          db.prepare("SELECT search_extensions FROM openclaw_schema_meta").get()?.search_extensions,
        ),
      ).not.toContain("memory.paths");
      expect(
        db
          .prepare(
            "SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = 'memory_index_sources' AND column_name = 'openclaw_search'",
          )
          .get(getPostgresPhysicalFacts(db)!.namespace),
      ).toBeUndefined();
    });
  });
});
