import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { RuntimeEnv } from "../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  backupSqliteCreateCommand,
  backupSqliteListCommand,
  backupSqliteRestoreCommand,
  backupSqliteVerifyCommand,
} from "./backup-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

function createGlobalDatabase(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      CREATE TABLE schema_meta (
        meta_key TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL
      );
      INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION});
      CREATE TABLE delivery_queue_entries (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      INSERT INTO delivery_queue_entries VALUES ('queued', 'do-not-restore');
      CREATE TABLE durable_entries (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO durable_entries (value) VALUES ('checkpointed');
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO durable_entries (value) VALUES ('committed-in-wal');
    `);
  } finally {
    database.close();
  }
}

function createAgentDatabase(databasePath: string, agentId: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
      CREATE TABLE schema_meta (
        meta_key TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT
      );
      CREATE TABLE durable_entries (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    database
      .prepare("INSERT INTO schema_meta VALUES ('primary', 'agent', ?, ?)")
      .run(OPENCLAW_AGENT_SCHEMA_VERSION, agentId);
    database.prepare("INSERT INTO durable_entries (value) VALUES (?)").run("agent-state");
  } finally {
    database.close();
  }
}

describe("SQLite backup commands", () => {
  it("creates, lists, verifies, and fresh-restores the global database", async () => {
    const tempDir = tempDirs.make("openclaw-backup-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "openclaw.sqlite");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const databasePath = resolveOpenClawStateSqlitePath();
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    createGlobalDatabase(databasePath);
    const runtime = createRuntimeCapture();

    const created = await backupSqliteCreateCommand(runtime, {
      global: true,
      repository: repositoryPath,
      json: true,
    });
    expect(created.manifest.database).toMatchObject({
      role: "global",
      basename: "openclaw.sqlite",
      userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(JSON.parse(runtime.logs.shift() ?? "{}")).toEqual(created);

    const listed = await backupSqliteListCommand(runtime, {
      repository: repositoryPath,
      json: true,
    });
    expect(listed.snapshots).toHaveLength(1);
    expect(listed.snapshots[0]?.manifest.snapshotId).toBe(created.manifest.snapshotId);

    const verified = await backupSqliteVerifyCommand(runtime, created.snapshotPath, {
      json: true,
    });
    expect(verified.manifest).toEqual(created.manifest);

    const restored = await backupSqliteRestoreCommand(runtime, created.snapshotPath, {
      target: restorePath,
      json: true,
    });
    expect(restored).toMatchObject({
      ok: true,
      snapshotPath: created.snapshotPath,
      targetPath: restorePath,
    });
    expect(runtime.errors).toEqual([]);

    const sqlite = requireNodeSqlite();
    const restoredDatabase = new sqlite.DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(
        restoredDatabase.prepare("SELECT value FROM durable_entries ORDER BY id").all(),
      ).toEqual([{ value: "checkpointed" }, { value: "committed-in-wal" }]);
      expect(
        restoredDatabase.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
      ).toEqual({ count: 0 });
    } finally {
      restoredDatabase.close();
    }
  });

  it("creates a snapshot for a normalized per-agent database", async () => {
    const tempDir = tempDirs.make("openclaw-backup-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const repositoryPath = path.join(tempDir, "snapshots");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "ops-team" });
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    createAgentDatabase(databasePath, "ops-team");
    const runtime = createRuntimeCapture();

    const created = await backupSqliteCreateCommand(runtime, {
      agent: "Ops Team",
      repository: repositoryPath,
    });

    expect(created.manifest.database).toEqual({
      role: "agent",
      agentId: "ops-team",
      basename: "openclaw-agent.sqlite",
      userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(runtime.logs).toEqual([expect.stringContaining("Database: agent:ops-team")]);
    expect(runtime.errors).toEqual([]);
  });

  it("requires exactly one named OpenClaw database source", async () => {
    const runtime = createRuntimeCapture();

    await expect(
      backupSqliteCreateCommand(runtime, { repository: "/tmp/snapshots" }),
    ).rejects.toThrow("Choose a SQLite snapshot source");
    await expect(
      backupSqliteCreateCommand(runtime, {
        global: true,
        agent: "main",
        repository: "/tmp/snapshots",
      }),
    ).rejects.toThrow("Choose exactly one SQLite snapshot source");
  });

  it("requires repository, snapshot, and restore target paths", async () => {
    const runtime = createRuntimeCapture();

    await expect(backupSqliteCreateCommand(runtime, { global: true })).rejects.toThrow(
      "Missing required --repository value",
    );
    await expect(backupSqliteVerifyCommand(runtime, " ", {})).rejects.toThrow(
      "Missing required <snapshot> value",
    );
    await expect(backupSqliteRestoreCommand(runtime, "/tmp/snapshot", {})).rejects.toThrow(
      "Missing required --target value",
    );
  });
});

function createRuntimeCapture(): RuntimeEnv & {
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log(value) {
      logs.push(String(value));
    },
    error(value) {
      errors.push(String(value));
    },
    exit(code) {
      throw new Error(`exit ${code}`);
    },
  };
}
