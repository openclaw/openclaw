import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteDatabaseIntegrityVerification } from "../infra/sqlite-database-admission.js";
import { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { recordOpenClawAgentDatabaseOpenFailure } from "./openclaw-agent-db-lifecycle.js";
import {
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
} from "./openclaw-quarantine-store.js";
import {
  readPersistedQuarantineRow,
  seedOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.test-support.js";
import { recordOpenClawStateDatabaseOpenFailure } from "./openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    using teardown = new DisposableStack();
    teardown.defer(cleanup);
    teardown.defer(closeOpenClawStateDatabaseForTest);
    teardown.defer(closeOpenClawAgentDatabasesForTest);
  });
});

function fixture() {
  const stateDir = tempDirs.make("openclaw-database-verify-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = path.join(stateDir, "agent.sqlite");
  return {
    env,
    databasePath,
    storePath: path.join(stateDir, "state", "openclaw-quarantine.sqlite"),
    agent: () => openOpenClawAgentDatabase({ agentId: "worker-1", env }),
    state: () => openOpenClawStateDatabase({ env }),
    read: () => readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env }),
    row: (pathname = databasePath) => readPersistedQuarantineRow(pathname, { env }),
    clear: (pathname = databasePath) => clearOpenClawDatabaseQuarantine(pathname, { env }),
    seed: (pathname = databasePath, reason = "corrupt index", kind: "agent" | "state" = "agent") =>
      seedOpenClawDatabaseQuarantine({ env, kind, path: pathname, reason }),
  };
}

function integrityError(message = "corrupt index") {
  return Object.assign(new Error(message), { name: "SqliteIntegrityError" });
}

const corrupt = expect.stringContaining("corrupt index");
const damage = expect.objectContaining({ name: "SqliteIntegrityError", message: corrupt });
const timestamp = expect.any(Number);

function execDatabase(pathname: string, sql: string) {
  using database = openDatabase(pathname);
  database.exec(sql);
}

function openDatabase(pathname: string, readOnly = false) {
  return new (requireNodeSqlite().DatabaseSync)(pathname, { readOnly });
}

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
it("revalidates a latched integrity failure after external repair", () => {
  const agentPath = f.agent().path;
  closeOpenClawAgentDatabasesForTest();
  recordOpenClawAgentDatabaseOpenFailure(agentPath, integrityError("corrupt generation"));
  execDatabase(agentPath, "CREATE TABLE generation_change (id INTEGER PRIMARY KEY) STRICT;");

  expect(f.agent().db.isOpen).toBe(true);
});

it("reports an uncleared quarantine row instead of claiming repair success", () => {
  const agentPath = f.agent().path;
  f.state();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  f.seed(agentPath);
  recordOpenClawAgentDatabaseOpenFailure(agentPath, integrityError());
  closeOpenClawStateDatabaseForTest();

  const before = f.row(agentPath);
  expect(before).toMatchObject({ kind: "agent", reason: "corrupt index" });
  {
    using quarantine = openDatabase(f.storePath);
    // chmod cannot refuse writes from root; fail the real SQLite writes instead.
    quarantine.exec(`
        CREATE TRIGGER refuse_quarantine_clear BEFORE DELETE ON quarantined_databases
        BEGIN SELECT RAISE(ABORT, 'quarantine store is read-only'); END;
      `);
    expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env: f.env })).toBe(false);
    expect(f.row(agentPath)).toEqual(before);
    expect(f.clear(agentPath)).toBe(false);
    expect(f.row(agentPath)).toEqual(before);
    expect(f.agent).toThrow(damage);
    quarantine.exec("DROP TRIGGER refuse_quarantine_clear;");
  }
  expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env: f.env })).toBe(true);
  expect(f.row(agentPath)).toBeUndefined();
  expect(f.agent().db.isOpen).toBe(true);
});

it("retains the quarantine history marker without storing integrity receipts", () => {
  const state = f.state();
  expect(f.row(state.path)).toBeUndefined();
  expect(fs.existsSync(f.storePath)).toBe(false);

  const agent = f.agent();
  expect(readSqliteDatabaseIntegrityVerification(agent.path)).toMatchObject({
    verifiedAt: expect.any(Number),
  });
  expect(f.row(agent.path)).toBeUndefined();
  using quarantine = openDatabase(f.storePath, true);
  expect(quarantine.prepare("SELECT * FROM agent_integrity_verifications").all()).toEqual([]);
});

it("clears historical quarantine rows with rollback journaling", () => {
  expect(f.clear()).toBe(true);
  f.seed();
  expect(f.row()).toEqual({ kind: "agent", quarantinedAt: timestamp, reason: "corrupt index" });

  {
    using raw = openDatabase(f.storePath, true);
    expect({
      ...raw.prepare("PRAGMA journal_mode").get(),
      synchronous: readSqliteNumberPragma(raw, "synchronous"),
      version: readSqliteNumberPragma(raw, "user_version"),
    }).toEqual({ journal_mode: "delete", synchronous: 2, version: 2 });
  }
  if (process.platform !== "win32") {
    expect(fs.statSync(path.dirname(f.storePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.storePath).mode & 0o777).toBe(0o600);
  }
  expect(f.clear()).toBe(true);
  expect(f.clear()).toBe(true);
  expect(f.row()).toBeUndefined();
});

it("expires a persisted quarantine when the verified database generation changes", () => {
  const { env, databasePath } = f;
  execDatabase(databasePath, "CREATE TABLE records (id INTEGER PRIMARY KEY) STRICT;");
  const generation = readStableSqliteFileGeneration(databasePath);

  seedOpenClawDatabaseQuarantine({
    env,
    generation,
    kind: "agent",
    path: databasePath,
    reason: "corrupt generation",
  });
  const quarantineBefore = f.row();
  expect(quarantineBefore?.reason).toBe("corrupt generation");
  expect(f.read()).toMatchObject({ name: "SqliteIntegrityError" });

  execDatabase(databasePath, "INSERT INTO records DEFAULT VALUES;");
  expect(f.read()).toBeUndefined();
  expect(f.row()).toEqual(quarantineBefore);
});

it("reads schema-v1 quarantine rows and migrates them when clearing another path", () => {
  const { databasePath, storePath } = f;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  {
    using legacy = openDatabase(storePath);
    legacy.exec(`
        CREATE TABLE quarantined_databases (
          path TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL, writer_app_version TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    legacy
      .prepare(
        "INSERT INTO quarantined_databases VALUES (?, 'agent', 'legacy quarantine', 1, NULL)",
      )
      .run(path.resolve(databasePath));
  }

  expect(f.row()).toEqual({ kind: "agent", quarantinedAt: 1, reason: "legacy quarantine" });
  expect(f.read()).toMatchObject({ name: "SqliteIntegrityError" });
  expect(f.clear(`${databasePath}.other`)).toBe(true);

  using migrated = openDatabase(storePath, true);
  expect(readSqliteNumberPragma(migrated, "user_version")).toBe(2);
  expect(
    migrated
      .prepare("SELECT reason, verified_generation FROM quarantined_databases WHERE path = ?")
      .get(path.resolve(databasePath)),
  ).toEqual({ reason: "legacy quarantine", verified_generation: null });
});

it("recovers an interrupted empty quarantine-store initialization", () => {
  fs.mkdirSync(path.dirname(f.storePath), { recursive: true });
  fs.writeFileSync(f.storePath, "", { mode: 0o600 });

  expect(f.read()).toBeUndefined();
  expect(f.clear()).toBe(true);
  f.seed();
  expect(f.row()?.reason).toBe("corrupt index");
});

it.skipIf(process.platform === "win32")(
  "recovers a hot rollback journal before reading quarantine",
  () => {
    f.seed(f.databasePath, "committed reason");

    const quarantineBefore = f.row();
    expect(quarantineBefore?.reason).toBe("committed reason");
    const crashed = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "-e",
        `
            import { DatabaseSync } from "node:sqlite";
            const database = new DatabaseSync(process.env.OPENCLAW_QUARANTINE_TEST_PATH);
            database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
            database.prepare("UPDATE quarantined_databases SET reason = 'uncommitted reason'").run();
            process.kill(process.pid, "SIGKILL");
          `,
      ],
      { env: { ...process.env, OPENCLAW_QUARANTINE_TEST_PATH: f.storePath } },
    );
    expect(crashed.signal).toBe("SIGKILL");
    expect(fs.existsSync(`${f.storePath}-journal`)).toBe(true);

    expect(f.read()).toMatchObject({ name: "SqliteIntegrityError" });
    expect(f.row()).toEqual(quarantineBefore);
  },
);

it("persists state failure quarantine across restart until doctor repair", () => {
  const statePath = f.state().path;
  closeOpenClawStateDatabaseForTest();

  f.seed(statePath, "corrupt index", "state");
  recordOpenClawStateDatabaseOpenFailure(statePath, integrityError());

  expect(f.row(statePath)).toMatchObject({ kind: "state", reason: "corrupt index" });
  expect(f.state).toThrow(damage);
  closeOpenClawStateDatabaseForTest();
  expect(f.state).toThrow(damage);
  expect(repairOpenClawStateDatabaseSchema({ env: f.env }).warnings).toEqual([]);
  expect(f.state().db.isOpen).toBe(true);
});
