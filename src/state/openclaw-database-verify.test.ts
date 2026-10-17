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

function quarantineStorePath(stateDir: string): string {
  return path.join(stateDir, "state", "openclaw-quarantine.sqlite");
}

function fixture() {
  const stateDir = tempDirs.make("openclaw-database-verify-");
  return {
    stateDir,
    env: { OPENCLAW_STATE_DIR: stateDir },
    databasePath: path.join(stateDir, "agent.sqlite"),
    storePath: quarantineStorePath(stateDir),
  };
}

function integrityError(message = "corrupt index") {
  return Object.assign(new Error(message), { name: "SqliteIntegrityError" });
}

function seed(
  env: NodeJS.ProcessEnv,
  pathname: string,
  reason = "corrupt index",
  kind: "agent" | "state" = "agent",
) {
  seedOpenClawDatabaseQuarantine({ env, kind, path: pathname, reason });
}

function execDatabase(pathname: string, sql: string) {
  using database = new (requireNodeSqlite().DatabaseSync)(pathname);
  database.exec(sql);
}

describe("OpenClaw database quarantine", () => {
  it("revalidates a latched integrity failure after external repair", () => {
    const { env } = fixture();
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    recordOpenClawAgentDatabaseOpenFailure(
      agentPath,
      integrityError("verified corrupt generation"),
    );
    execDatabase(agentPath, "CREATE TABLE generation_change (id INTEGER PRIMARY KEY) STRICT;");

    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("reports an uncleared quarantine row instead of claiming repair success", () => {
    const { env, storePath } = fixture();
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    openOpenClawStateDatabase({ env });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    seed(env, agentPath);
    recordOpenClawAgentDatabaseOpenFailure(agentPath, integrityError());
    closeOpenClawStateDatabaseForTest();

    const before = readPersistedQuarantineRow(agentPath, { env });
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
      expect(readPersistedQuarantineRow(agentPath, { env })).toEqual(before);
      expect(clearOpenClawDatabaseQuarantine(agentPath, { env })).toBe(false);
      expect(readPersistedQuarantineRow(agentPath, { env })).toEqual(before);
      expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
        expect.objectContaining({
          name: "SqliteIntegrityError",
          message: expect.stringContaining("corrupt index"),
        }),
      );
      quarantine.exec("DROP TRIGGER refuse_quarantine_clear;");
    } finally {
      quarantine.close();
    }
    expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env })).toBe(true);
    expect(readPersistedQuarantineRow(agentPath, { env })).toBeUndefined();
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("retains the quarantine history marker without storing integrity receipts", () => {
    const { stateDir, env } = fixture();
    const state = openOpenClawStateDatabase({ env });
    expect(readPersistedQuarantineRow(state.path, { env })).toBeUndefined();
    expect(fs.existsSync(quarantineStorePath(stateDir))).toBe(false);

    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(readSqliteDatabaseIntegrityVerification(agent.path)).toMatchObject({
      verifiedAt: expect.any(Number),
    });
    expect(readPersistedQuarantineRow(agent.path, { env })).toBeUndefined();
    const { DatabaseSync } = requireNodeSqlite();
    using quarantine = new DatabaseSync(quarantineStorePath(stateDir), { readOnly: true });
    expect(quarantine.prepare("SELECT * FROM agent_integrity_verifications").all()).toEqual([]);
  });

  it("clears historical quarantine rows with rollback journaling", () => {
    const { env, databasePath, storePath } = fixture();

    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    seed(env, databasePath);
    expect(readPersistedQuarantineRow(databasePath, { env })).toEqual({
      kind: "agent",
      quarantinedAt: expect.any(Number),
      reason: "corrupt index",
    });

    const { DatabaseSync } = requireNodeSqlite();
    {
      using raw = new DatabaseSync(storePath, { readOnly: true });
      expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(readSqliteNumberPragma(raw, "synchronous")).toBe(2);
      expect(readSqliteNumberPragma(raw, "user_version")).toBe(2);
    }
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(storePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    }
    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(readPersistedQuarantineRow(databasePath, { env })).toBeUndefined();
  });

  it("expires a persisted quarantine when the verified database generation changes", () => {
    const { env, databasePath } = fixture();
    execDatabase(databasePath, "CREATE TABLE records (id INTEGER PRIMARY KEY) STRICT;");
    const generation = readStableSqliteFileGeneration(databasePath);

    seedOpenClawDatabaseQuarantine({
      env,
      generation,
      kind: "agent",
      path: databasePath,
      reason: "corrupt generation",
    });
    const quarantineBefore = readPersistedQuarantineRow(databasePath, { env });
    expect(quarantineBefore?.reason).toBe("corrupt generation");
    expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toMatchObject({
      name: "SqliteIntegrityError",
    });

    execDatabase(databasePath, "INSERT INTO records DEFAULT VALUES;");
    expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toBeUndefined();
    expect(readPersistedQuarantineRow(databasePath, { env })).toEqual(quarantineBefore);
  });

  it("reads schema-v1 quarantine rows and migrates them when clearing another path", () => {
    const { env, databasePath, storePath } = fixture();
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

    expect(readPersistedQuarantineRow(databasePath, { env })).toEqual({
      kind: "agent",
      quarantinedAt: 1,
      reason: "legacy quarantine",
    });
    expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toMatchObject({
      name: "SqliteIntegrityError",
    });
    expect(clearOpenClawDatabaseQuarantine(`${databasePath}.other`, { env })).toBe(true);

    using migrated = new DatabaseSync(storePath, { readOnly: true });
    expect(readSqliteNumberPragma(migrated, "user_version")).toBe(2);
    expect(
      migrated
        .prepare("SELECT reason, verified_generation FROM quarantined_databases WHERE path = ?")
        .get(path.resolve(databasePath)),
    ).toEqual({ reason: "legacy quarantine", verified_generation: null });
  });

  it("recovers an interrupted empty quarantine-store initialization", () => {
    const { env, databasePath, storePath } = fixture();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "", { mode: 0o600 });

    expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toBeUndefined();
    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    seed(env, databasePath);
    expect(readPersistedQuarantineRow(databasePath, { env })?.reason).toBe("corrupt index");
  });

  it.skipIf(process.platform === "win32")(
    "recovers a hot rollback journal before reading quarantine",
    () => {
      const { env, databasePath, storePath } = fixture();
      seed(env, databasePath, "committed reason");

      const quarantineBefore = readPersistedQuarantineRow(databasePath, { env });
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

      expect(readOpenClawDatabaseQuarantineFailure("agent", databasePath, { env })).toMatchObject({
        name: "SqliteIntegrityError",
      });
      expect(readPersistedQuarantineRow(databasePath, { env })).toEqual(quarantineBefore);
    },
  );

  it("persists state failure quarantine across restart until doctor repair", () => {
    const { env, storePath } = fixture();
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();

    seed(env, statePath, "corrupt index", "state");
    recordOpenClawStateDatabaseOpenFailure(statePath, integrityError());

    const { DatabaseSync } = requireNodeSqlite();
    {
      using raw = new DatabaseSync(storePath, { readOnly: true });
      expect(
        raw.prepare("SELECT kind, reason FROM quarantined_databases WHERE path = ?").get(statePath),
      ).toEqual({ kind: "state", reason: "corrupt index" });
    }
    expect(() => openOpenClawStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    closeOpenClawStateDatabaseForTest();
    expect(() => openOpenClawStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    expect(repairOpenClawStateDatabaseSchema({ env }).warnings).toEqual([]);
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
  });
});
