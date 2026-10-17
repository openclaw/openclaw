import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    try {
      closeOpenClawAgentDatabasesForTest();
    } finally {
      try {
        closeOpenClawStateDatabaseForTest();
      } finally {
        cleanup();
      }
    }
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

const integrityFailure = expect.objectContaining({
  name: "SqliteIntegrityError",
  message: expect.stringContaining("corrupt index"),
});

function execDatabase(pathname: string, sql: string) {
  using database = new (requireNodeSqlite().DatabaseSync)(pathname);
  database.exec(sql);
}

describe("OpenClaw database quarantine", () => {
  it("revalidates a latched integrity failure after external repair", () => {
    const f = fixture();
    const agentPath = f.agent().path;
    closeOpenClawAgentDatabasesForTest();
    recordOpenClawAgentDatabaseOpenFailure(
      agentPath,
      integrityError("verified corrupt generation"),
    );
    execDatabase(agentPath, "CREATE TABLE generation_change (id INTEGER PRIMARY KEY) STRICT;");

    expect(f.agent().db.isOpen).toBe(true);
  });

  it("reports an uncleared quarantine row instead of claiming repair success", () => {
    const f = fixture();
    const { env, storePath } = f;
    const agentPath = f.agent().path;
    f.state();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    f.seed(agentPath);
    recordOpenClawAgentDatabaseOpenFailure(agentPath, integrityError());
    closeOpenClawStateDatabaseForTest();

    const before = f.row(agentPath);
    expect(before).toMatchObject({ kind: "agent", reason: "corrupt index" });
    const { DatabaseSync } = requireNodeSqlite();
    const quarantine = new DatabaseSync(storePath);
    try {
      // chmod cannot refuse writes from root; fail the real SQLite writes instead.
      quarantine.exec(`
        CREATE TRIGGER refuse_quarantine_clear BEFORE DELETE ON quarantined_databases
        BEGIN SELECT RAISE(ABORT, 'quarantine store is read-only'); END;
      `);
      expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env })).toBe(false);
      expect(f.row(agentPath)).toEqual(before);
      expect(f.clear(agentPath)).toBe(false);
      expect(f.row(agentPath)).toEqual(before);
      expect(f.agent).toThrow(integrityFailure);
      quarantine.exec("DROP TRIGGER refuse_quarantine_clear;");
    } finally {
      quarantine.close();
    }
    expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env })).toBe(true);
    expect(f.row(agentPath)).toBeUndefined();
    expect(f.agent().db.isOpen).toBe(true);
  });

  it("retains the quarantine history marker without storing integrity receipts", () => {
    const f = fixture();
    const state = f.state();
    expect(f.row(state.path)).toBeUndefined();
    expect(fs.existsSync(f.storePath)).toBe(false);

    const agent = f.agent();
    expect(readSqliteDatabaseIntegrityVerification(agent.path)).toMatchObject({
      verifiedAt: expect.any(Number),
    });
    expect(f.row(agent.path)).toBeUndefined();
    const { DatabaseSync } = requireNodeSqlite();
    using quarantine = new DatabaseSync(f.storePath, { readOnly: true });
    expect(quarantine.prepare("SELECT * FROM agent_integrity_verifications").all()).toEqual([]);
  });

  it("clears historical quarantine rows with rollback journaling", () => {
    const f = fixture();
    const { storePath } = f;

    expect(f.clear()).toBe(true);
    f.seed();
    expect(f.row()).toEqual({
      kind: "agent",
      quarantinedAt: expect.any(Number),
      reason: "corrupt index",
    });

    const { DatabaseSync } = requireNodeSqlite();
    {
      using raw = new DatabaseSync(storePath, { readOnly: true });
      expect({
        ...raw.prepare("PRAGMA journal_mode").get(),
        synchronous: readSqliteNumberPragma(raw, "synchronous"),
        version: readSqliteNumberPragma(raw, "user_version"),
      }).toEqual({ journal_mode: "delete", synchronous: 2, version: 2 });
    }
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(storePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    }
    expect(f.clear()).toBe(true);
    expect(f.clear()).toBe(true);
    expect(f.row()).toBeUndefined();
  });

  it("expires a persisted quarantine when the verified database generation changes", () => {
    const f = fixture();
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
    expect(f.read()).toMatchObject({
      name: "SqliteIntegrityError",
    });

    execDatabase(databasePath, "INSERT INTO records DEFAULT VALUES;");
    expect(f.read()).toBeUndefined();
    expect(f.row()).toEqual(quarantineBefore);
  });

  it("reads schema-v1 quarantine rows and migrates them when clearing another path", () => {
    const f = fixture();
    const { databasePath, storePath } = f;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    {
      using legacy = new DatabaseSync(storePath);
      legacy.exec(`
        CREATE TABLE quarantined_databases (
          path TEXT NOT NULL PRIMARY KEY,
          kind TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL,
          writer_app_version TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
      legacy
        .prepare(
          "INSERT INTO quarantined_databases (path, kind, reason, quarantined_at) VALUES (?, ?, ?, ?)",
        )
        .run(path.resolve(databasePath), "agent", "legacy quarantine", 1);
    }

    expect(f.row()).toEqual({
      kind: "agent",
      quarantinedAt: 1,
      reason: "legacy quarantine",
    });
    expect(f.read()).toMatchObject({
      name: "SqliteIntegrityError",
    });
    expect(f.clear(`${databasePath}.other`)).toBe(true);

    using migrated = new DatabaseSync(storePath, { readOnly: true });
    expect(readSqliteNumberPragma(migrated, "user_version")).toBe(2);
    expect(
      migrated
        .prepare("SELECT reason, verified_generation FROM quarantined_databases WHERE path = ?")
        .get(path.resolve(databasePath)),
    ).toEqual({ reason: "legacy quarantine", verified_generation: null });
  });

  it("recovers an interrupted empty quarantine-store initialization", () => {
    const f = fixture();
    const { storePath } = f;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "", { mode: 0o600 });

    expect(f.read()).toBeUndefined();
    expect(f.clear()).toBe(true);
    f.seed();
    expect(f.row()?.reason).toBe("corrupt index");
  });

  it.skipIf(process.platform === "win32")(
    "recovers a hot rollback journal before reading quarantine",
    () => {
      const f = fixture();
      const { storePath } = f;
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
        { env: { ...process.env, OPENCLAW_QUARANTINE_TEST_PATH: storePath } },
      );
      expect(crashed.signal).toBe("SIGKILL");
      expect(fs.existsSync(`${storePath}-journal`)).toBe(true);

      expect(f.read()).toMatchObject({
        name: "SqliteIntegrityError",
      });
      expect(f.row()).toEqual(quarantineBefore);
    },
  );

  it("persists state failure quarantine across restart until doctor repair", () => {
    const f = fixture();
    const { env, storePath } = f;
    const statePath = f.state().path;
    closeOpenClawStateDatabaseForTest();

    f.seed(statePath, "corrupt index", "state");
    recordOpenClawStateDatabaseOpenFailure(statePath, integrityError());

    const { DatabaseSync } = requireNodeSqlite();
    {
      using raw = new DatabaseSync(storePath, { readOnly: true });
      expect(
        raw.prepare("SELECT kind, reason FROM quarantined_databases WHERE path = ?").get(statePath),
      ).toEqual({ kind: "state", reason: "corrupt index" });
    }
    expect(f.state).toThrow(integrityFailure);
    closeOpenClawStateDatabaseForTest();
    expect(f.state).toThrow(integrityFailure);
    expect(repairOpenClawStateDatabaseSchema({ env }).warnings).toEqual([]);
    expect(f.state().db.isOpen).toBe(true);
  });
});
