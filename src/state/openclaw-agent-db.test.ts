import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import {
  collectSqliteSchemaShape,
  createSqliteSchemaShapeFromSql,
} from "./sqlite-schema-shape.test-support.js";

type AgentDbTestDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "memory_index_chunks" | "memory_index_sources" | "schema_meta" | "sessions"
>;
type EmbeddingTable = "memory_index_chunks" | "memory_embedding_cache";

function readSqliteColumnTypes(
  database: ReturnType<typeof openOpenClawAgentDatabase>["db"],
  table: EmbeddingTable,
): Record<string, string> {
  return Object.fromEntries(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => {
        const column = row as { name?: unknown; type?: unknown };
        return [String(column.name), String(column.type)];
      }),
  );
}

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-"));
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("openclaw agent database", () => {
  it("resolves under the per-agent state directory", () => {
    const stateDir = createTempStateDir();

    expect(
      resolveOpenClawAgentSqlitePath({
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toBe(path.join(stateDir, "agents", "worker-1", "agent", "openclaw-agent.sqlite"));
  });

  it("creates the per-agent schema and registers it globally", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(collectSqliteSchemaShape(database.db)).toEqual(
      createSqliteSchemaShapeFromSql(new URL("./openclaw-agent-schema.sql", import.meta.url)),
    );
    expect(database.agentId).toBe("worker-1");
    expect(database.path).toBe(
      path.join(stateDir, "agents", "worker-1", "agent", "openclaw-agent.sqlite"),
    );

    const registered = listOpenClawRegisteredAgentDatabases({
      env: { OPENCLAW_STATE_DIR: stateDir },
    }).find((entry) => entry.agentId === "worker-1");

    expect(registered).toMatchObject({
      agentId: "worker-1",
      path: database.path,
      schemaVersion: 1,
    });
    expect(registered?.sizeBytes).toBeGreaterThan(0);
  });

  it("configures durable SQLite connection pragmas", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(readSqliteNumberPragma(database.db, "busy_timeout")).toBe(30_000);
    expect(readSqliteNumberPragma(database.db, "foreign_keys")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "synchronous")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "wal_autocheckpoint")).toBe(1000);
    const journalMode = database.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("wal");
  });

  it("records durable per-agent schema metadata", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const agentDb = getNodeSqliteKysely<AgentDbTestDatabase>(database.db);

    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        agentDb.selectFrom("schema_meta").select(["role", "schema_version", "agent_id"]),
      ),
    ).toEqual({
      role: "agent",
      schema_version: 1,
      agent_id: "worker-1",
    });
  });

  it("stores memory embeddings as SQLite blobs", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(readSqliteColumnTypes(database.db, "memory_index_chunks").embedding).toBe("BLOB");
    expect(readSqliteColumnTypes(database.db, "memory_embedding_cache").embedding).toBe("BLOB");
  });

  it("cascades session-derived memory index sources and chunks", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const agentDb = getNodeSqliteKysely<AgentDbTestDatabase>(database.db);

    executeSqliteQuerySync(
      database.db,
      agentDb.insertInto("sessions").values({
        session_id: "session-1",
        session_key: "main:session-1",
        created_at: 1,
        updated_at: 1,
      }),
    );
    executeSqliteQuerySync(
      database.db,
      agentDb.insertInto("memory_index_sources").values({
        source_kind: "sessions",
        source_key: "session:session-1",
        path: "transcript:worker-1:session-1",
        session_id: "session-1",
        hash: "hash-1",
        mtime: 1,
        size: 1,
      }),
    );
    executeSqliteQuerySync(
      database.db,
      agentDb.insertInto("memory_index_chunks").values({
        id: "chunk-1",
        source_kind: "sessions",
        source_key: "session:session-1",
        path: "transcript:worker-1:session-1",
        session_id: "session-1",
        start_line: 1,
        end_line: 1,
        hash: "chunk-hash-1",
        model: "fts-only",
        text: "remember this",
        embedding: new Uint8Array(),
        embedding_dims: 0,
        updated_at: 1,
      }),
    );

    executeSqliteQuerySync(
      database.db,
      agentDb.deleteFrom("sessions").where("session_id", "=", "session-1"),
    );

    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        agentDb
          .selectFrom("memory_index_sources")
          .select((eb) => eb.fn.countAll<number>().as("count")),
      )?.count,
    ).toBe(0);
    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        agentDb
          .selectFrom("memory_index_chunks")
          .select((eb) => eb.fn.countAll<number>().as("count")),
      )?.count,
    ).toBe(0);
  });
});
