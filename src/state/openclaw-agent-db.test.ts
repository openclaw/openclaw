// OpenClaw agent database tests cover agent-scoped DB storage and migrations.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { listOpenFileDescriptorsForPath } from "../infra/open-file-descriptors.test-support.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  collectSqliteSchemaShape,
  createSqliteSchemaShapeFromSql,
} from "./sqlite-schema-shape.test-support.js";

type AgentDbTestDatabase = Pick<OpenClawAgentKyselyDatabase, "schema_meta">;

type RegisteredAgentDatabaseRow = {
  agent_id: string;
  path: string;
  schema_version: number;
  size_bytes: number | null;
};

const agentDbTempDirs: string[] = [];

function createTempStateDir(): string {
  return makeTempDir(agentDbTempDirs, "openclaw-agent-db-");
}

function listRegisteredAgentDatabasesForTest(options: { env?: NodeJS.ProcessEnv } = {}) {
  const rows = openOpenClawStateDatabase(options)
    .db.prepare(
      "SELECT agent_id, path, schema_version, size_bytes FROM agent_databases ORDER BY agent_id, path",
    )
    .all() as RegisteredAgentDatabaseRow[];
  return rows.map((row) => ({
    agentId: row.agent_id,
    path: row.path,
    schemaVersion: row.schema_version,
    sizeBytes: row.size_bytes,
  }));
}

afterAll(() => {
  cleanupTempDirs(agentDbTempDirs);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("openclaw agent database", () => {
  it("resolves under the per-agent state directory", () => {
    const stateDir = createTempStateDir();

    expect(
      resolveOpenClawAgentSqlitePath({
        agentId: "Worker-1",
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toBe(path.join(stateDir, "agents", "worker-1", "agent", "openclaw-agent.sqlite"));
  });

  it("keeps test default state under a worker-sharded temp directory", () => {
    expect(
      resolveOpenClawAgentSqlitePath({
        agentId: "main",
        env: {
          VITEST: "true",
          VITEST_WORKER_ID: "7",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(
      path.join(
        os.tmpdir(),
        "openclaw-test-state",
        `${process.pid}-7`,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      ),
    );
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

    const registered = listRegisteredAgentDatabasesForTest({
      env: { OPENCLAW_STATE_DIR: stateDir },
    }).find((entry) => entry.agentId === "worker-1");

    expect(registered).toMatchObject({
      agentId: "worker-1",
      path: database.path,
      schemaVersion: 1,
    });
    expect(registered?.sizeBytes).toBeGreaterThan(0);
  });

  it.runIf(process.platform === "linux")("closes the database when initialization fails", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "agent.sqlite");
    fs.writeFileSync(databasePath, "not a sqlite database");

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: stateDir },
        path: databasePath,
      }),
    ).toThrow("file is not a database");
    expect(listOpenFileDescriptorsForPath(databasePath)).toEqual([]);
  });

  it("keeps multiple registered paths for the same agent", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const relocatedPath = path.join(stateDir, "relocated", "worker-1.sqlite");
    const relocated = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
      path: relocatedPath,
    });
    const defaultDatabase = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
    });

    expect(
      listRegisteredAgentDatabasesForTest({ env })
        .filter((entry) => entry.agentId === "worker-1")
        .map((entry) => entry.path),
    ).toEqual([defaultDatabase.path, relocated.path].toSorted());
  });

  it("rejects the legacy agent registry primary key with a doctor repair hint", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const stateDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(stateDatabasePath);
    legacyDb.exec(`
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        size_bytes INTEGER
      );
      INSERT INTO agent_databases (
        agent_id,
        path,
        schema_version,
        last_seen_at,
        size_bytes
      ) VALUES (
        'worker-1',
        '/legacy/worker-1/openclaw-agent.sqlite',
        1,
        10,
        20
      );
    `);
    legacyDb.close();

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-1",
        env,
      }),
    ).toThrow(/run openclaw doctor --fix/);
  });

  it("keys explicit relative paths by resolved database pathname", () => {
    const agentModuleUrl = new URL("./openclaw-agent-db.ts", import.meta.url).href;
    const stateModuleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import os from "node:os";
          import path from "node:path";
          import {
            closeOpenClawAgentDatabasesForTest,
            openOpenClawAgentDatabase,
          } from ${JSON.stringify(agentModuleUrl)};
          import {
            closeOpenClawStateDatabaseForTest,
            openOpenClawStateDatabase,
          } from ${JSON.stringify(stateModuleUrl)};

          const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-state-"));
          const env = { OPENCLAW_STATE_DIR: stateDir };
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-relative-"));
          const firstDir = path.join(root, "first");
          const secondDir = path.join(root, "second");
          fs.mkdirSync(firstDir);
          fs.mkdirSync(secondDir);
          const previousCwd = process.cwd();
          try {
            process.chdir(firstDir);
            const first = openOpenClawAgentDatabase({
              agentId: "worker-1",
              env,
              path: "agent.sqlite",
            });

            process.chdir(secondDir);
            const second = openOpenClawAgentDatabase({
              agentId: "worker-1",
              env,
              path: "agent.sqlite",
            });

            console.log(JSON.stringify({
              sameHandle: first === second,
              firstFileExists: fs.existsSync(path.join(firstDir, "agent.sqlite")),
              secondFileExists: fs.existsSync(path.join(secondDir, "agent.sqlite")),
              registeredPaths: openOpenClawStateDatabase({ env }).db
                .prepare("SELECT path FROM agent_databases WHERE agent_id = ? ORDER BY path")
                .all("worker-1")
                .map((entry) => entry.path),
              expectedPaths: [first.path, second.path].toSorted(),
            }));
          } finally {
            process.chdir(previousCwd);
            closeOpenClawAgentDatabasesForTest();
            closeOpenClawStateDatabaseForTest();
          }
        `,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output) as {
      expectedPaths: string[];
      firstFileExists: boolean;
      registeredPaths: string[];
      sameHandle: boolean;
      secondFileExists: boolean;
    };

    expect(result.sameHandle).toBe(false);
    expect(result.firstFileExists).toBe(true);
    expect(result.secondFileExists).toBe(true);
    expect(result.registeredPaths).toEqual(result.expectedPaths);
  });

  it("rejects sharing one explicit database path across agent ids", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "relocated", "shared.sqlite");

    openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
      path: databasePath,
    });

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-2",
        env,
        path: databasePath,
      }),
    ).toThrow(/already open for agent worker-1/);

    closeOpenClawAgentDatabasesForTest();
    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-2",
        env,
        path: databasePath,
      }),
    ).toThrow(/belongs to agent worker-1/);
  });

  it("rejects explicit paths that point at the global state database", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const stateDatabase = openOpenClawStateDatabase({
      env,
      path: databasePath,
    });
    closeOpenClawStateDatabaseForTest();

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-1",
        env,
        path: stateDatabase.path,
      }),
    ).toThrow(/schema role global/);

    const reopenedStateDatabase = openOpenClawStateDatabase({
      env,
      path: databasePath,
    });
    const row = reopenedStateDatabase.db
      .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
      .get() as { agent_id?: unknown; role?: unknown } | undefined;
    expect(row).toEqual({ role: "global", agent_id: null });
  });

  it("does not chmod shared parent directories for explicit database paths", () => {
    const parentDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: parentDir };
    fs.chmodSync(parentDir, 0o755);
    const databasePath = path.join(parentDir, "worker-1.sqlite");

    openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
      path: databasePath,
    });

    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o755);
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

  it("refuses to open newer per-agent schema versions", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA user_version = 2;");
    db.close();

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toThrow(/newer schema version 2/);
  });
});
