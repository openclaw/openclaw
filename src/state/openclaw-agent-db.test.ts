import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
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

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-"));
}

function readPragmaNumber(db: import("node:sqlite").DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma] ?? row?.timeout;
  return typeof value === "bigint" ? Number(value) : Number(value);
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
      schemaVersion: 4,
    });
    expect(registered?.sizeBytes).toBeGreaterThan(0);
  });

  it("configures durable SQLite connection pragmas", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(readPragmaNumber(database.db, "busy_timeout")).toBe(30_000);
    expect(readPragmaNumber(database.db, "foreign_keys")).toBe(1);
    expect(readPragmaNumber(database.db, "synchronous")).toBe(1);
    expect(readPragmaNumber(database.db, "wal_autocheckpoint")).toBe(1000);
    const journalMode = database.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("wal");
  });

  it("backfills transcript event identities when upgrading existing agent databases", () => {
    const stateDir = createTempStateDir();
    const dbPath = resolveOpenClawAgentSqlitePath({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const oldDb = new sqlite.DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      INSERT INTO transcript_events(session_id, seq, event_json, created_at)
      VALUES (
        'session-1',
        0,
        '{"type":"message","id":"m1","parentId":null,"message":{"idempotencyKey":"idem-1"}}',
        123
      );
      PRAGMA user_version = 3;
    `);
    oldDb.close();

    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(
      database.db
        .prepare(
          "SELECT event_id, has_parent, message_idempotency_key FROM transcript_event_identities",
        )
        .all(),
    ).toEqual([{ event_id: "m1", has_parent: 1, message_idempotency_key: "idem-1" }]);
  });
});
