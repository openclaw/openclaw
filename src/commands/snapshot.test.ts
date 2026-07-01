import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  snapshotCreateCommand,
  snapshotListCommand,
  snapshotRestoreCommand,
  snapshotVerifyCommand,
} from "./snapshot.js";

const SNAPSHOT_ARTIFACT_FILES = ["database.sqlite", "manifest.json"];

let workspaceDir: string;
let previousOpenClawStateDir: string | undefined;

describe("snapshot cli", () => {
  beforeEach(async () => {
    previousOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
    workspaceDir = await fs.mkdtemp(path.join(tmpdir(), "snapshot-cli-"));
  });

  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    if (previousOpenClawStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousOpenClawStateDir;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("creates, lists, verifies, and restores a SQLite snapshot", async () => {
    const runtime = createRuntimeCapture();
    const dbPath = path.join(workspaceDir, "source.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    const restorePath = path.join(workspaceDir, "restore", "source.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA user_version = 12;
        CREATE TABLE entries (value TEXT NOT NULL);
        INSERT INTO entries (value) VALUES ('from-cli');
      `);
    } finally {
      db.close();
    }

    await expect(
      snapshotCreateCommand(
        {
          db: dbPath,
          repository: repositoryPath,
          id: "cli-db",
          kind: "test",
          json: true,
        },
        runtime,
      ),
    ).resolves.toBe(0);
    const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshotPath?: string;
      manifest?: { database?: { id?: string; kind?: string; userVersion?: number } };
    };
    expect(createReport.snapshotPath).toBeTruthy();
    expect(createReport.manifest?.database).toMatchObject({
      id: "cli-db",
      kind: "test",
      userVersion: 12,
    });

    await expect(
      snapshotListCommand({ repository: repositoryPath, json: true }, runtime),
    ).resolves.toBe(0);
    const listReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshots?: unknown[];
    };
    expect(listReport.snapshots).toHaveLength(1);

    await expect(
      snapshotVerifyCommand(createReport.snapshotPath ?? "", { json: true }, runtime),
    ).resolves.toBe(0);
    const verifyReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      ok?: boolean;
      integrityCheck?: string[];
    };
    expect(verifyReport).toMatchObject({ ok: true, integrityCheck: ["ok"] });

    await expect(
      snapshotRestoreCommand(
        createReport.snapshotPath ?? "",
        { target: restorePath, json: true },
        runtime,
      ),
    ).resolves.toBe(0);
    const restoreReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      ok?: boolean;
      targetPath?: string;
    };
    expect(restoreReport).toMatchObject({ ok: true, targetPath: restorePath });
    expect(runtime.errors).toEqual([]);

    const restored = new DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM entries").all()).toEqual([{ value: "from-cli" }]);
    } finally {
      restored.close();
    }
  });

  it("returns command usage errors without throwing", async () => {
    const runtime = createRuntimeCapture();

    await expect(snapshotCreateCommand({ repository: workspaceDir }, runtime)).resolves.toBe(2);

    expect(runtime.logs).toEqual([]);
    expect(runtime.errors).toEqual([
      "Missing snapshot source. Provide one of --db <path>, --target global, or --agent <id>.",
    ]);
  });

  it("creates a snapshot from the named global OpenClaw database", async () => {
    const runtime = createRuntimeCapture();
    const stateDir = path.join(workspaceDir, "state-root");
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await createSqliteDatabase(dbPath, "from-global");

    await expect(
      snapshotCreateCommand({ target: "global", repository: repositoryPath, json: true }, runtime),
    ).resolves.toBe(0);

    const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshotPath?: string;
      manifest?: { database?: { id?: string; kind?: string } };
    };
    expect(createReport.snapshotPath).toBeTruthy();
    expect(createReport.manifest?.database).toMatchObject({
      id: "global",
      kind: "global-control-plane",
    });
    expect(runtime.errors).toEqual([]);
  });

  it("scrubs transient delivery queue rows from named global snapshots", async () => {
    const runtime = createRuntimeCapture();
    const stateDir = path.join(workspaceDir, "state-root");
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE entries (value TEXT NOT NULL);
        CREATE TABLE delivery_queue_entries (id TEXT PRIMARY KEY);
        INSERT INTO entries (value) VALUES ('durable-global');
        INSERT INTO delivery_queue_entries (id) VALUES ('transient-queue');
      `);

      await expect(
        snapshotCreateCommand(
          { target: "global", repository: repositoryPath, json: true },
          runtime,
        ),
      ).resolves.toBe(0);

      const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
        snapshotPath?: string;
      };
      const artifactPath = path.join(createReport.snapshotPath ?? "", "database.sqlite");
      const artifact = new DatabaseSync(artifactPath, { readOnly: true });
      try {
        expect(artifact.prepare("SELECT value FROM entries").all()).toEqual([
          { value: "durable-global" },
        ]);
        expect(
          artifact.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
        ).toEqual({ count: 0 });
      } finally {
        artifact.close();
      }

      expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
    expect(runtime.errors).toEqual([]);
  });

  it("creates a snapshot from the named per-agent OpenClaw database", async () => {
    const runtime = createRuntimeCapture();
    const stateDir = path.join(workspaceDir, "state-root");
    const dbPath = path.join(stateDir, "agents", "ops-team", "agent", "openclaw-agent.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await createSqliteDatabase(dbPath, "from-agent");

    await expect(
      snapshotCreateCommand({ agent: "Ops Team", repository: repositoryPath, json: true }, runtime),
    ).resolves.toBe(0);

    const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshotPath?: string;
      manifest?: { database?: { id?: string; kind?: string } };
    };
    expect(createReport.snapshotPath).toBeTruthy();
    expect(createReport.manifest?.database).toMatchObject({
      id: "agent:ops-team",
      kind: "agent-data-plane",
    });
    expect(runtime.errors).toEqual([]);
  });

  it("restores a copied snapshot artifact from a named OpenClaw database", async () => {
    const runtime = createRuntimeCapture();
    const stateDir = path.join(workspaceDir, "state-root");
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    const syncedSnapshotPath = path.join(workspaceDir, "synced", "snapshot");
    const restorePath = path.join(workspaceDir, "hydrated", "openclaw.sqlite");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await fs.mkdir(path.dirname(dbPath), { recursive: true });

    const liveDb = new DatabaseSync(dbPath);
    try {
      liveDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA user_version = 42;
        CREATE TABLE entries (value TEXT NOT NULL);
        INSERT INTO entries (value) VALUES ('portable-state');
      `);

      await expect(
        snapshotCreateCommand(
          { target: "global", repository: repositoryPath, json: true },
          runtime,
        ),
      ).resolves.toBe(0);

      const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
        snapshotPath?: string;
        manifest?: { artifact?: { path?: string }; database?: { id?: string } };
      };
      expect(createReport.manifest?.artifact?.path).toBe("database.sqlite");
      expect(createReport.manifest?.database?.id).toBe("global");
      expect(createReport.snapshotPath).toBeTruthy();

      await expect(readSortedDir(createReport.snapshotPath ?? "")).resolves.toEqual(
        SNAPSHOT_ARTIFACT_FILES,
      );
      await expect(fs.stat(`${dbPath}-wal`)).resolves.toBeTruthy();
      await expect(fs.stat(`${dbPath}-shm`)).resolves.toBeTruthy();
      await fs.cp(createReport.snapshotPath ?? "", syncedSnapshotPath, { recursive: true });
    } finally {
      liveDb.close();
    }

    await expect(readSortedDir(syncedSnapshotPath)).resolves.toEqual(SNAPSHOT_ARTIFACT_FILES);
    await fs.mkdir(path.dirname(restorePath), { recursive: true });
    await fs.writeFile(`${restorePath}-wal`, "stale wal sidecar");
    await fs.writeFile(`${restorePath}-shm`, "stale shm sidecar");
    await fs.writeFile(`${restorePath}-journal`, "stale rollback journal sidecar");

    await expect(
      snapshotRestoreCommand(syncedSnapshotPath, { target: restorePath, json: true }, runtime),
    ).resolves.toBe(0);

    const restoreReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      ok?: boolean;
      targetPath?: string;
      manifest?: { database?: { id?: string; userVersion?: number } };
    };
    expect(restoreReport).toMatchObject({
      ok: true,
      targetPath: restorePath,
      manifest: {
        database: {
          id: "global",
          userVersion: 42,
        },
      },
    });
    await expect(fileExists(`${restorePath}-wal`)).resolves.toBe(false);
    await expect(fileExists(`${restorePath}-shm`)).resolves.toBe(false);
    await expect(fileExists(`${restorePath}-journal`)).resolves.toBe(false);

    const restored = new DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(restored.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(restored.prepare("SELECT value FROM entries").all()).toEqual([
        { value: "portable-state" },
      ]);
    } finally {
      restored.close();
    }
    expect(runtime.errors).toEqual([]);
  });

  it("rejects ambiguous snapshot source selectors", async () => {
    const runtime = createRuntimeCapture();

    await expect(
      snapshotCreateCommand(
        { db: "/tmp/source.sqlite", target: "global", repository: workspaceDir },
        runtime,
      ),
    ).resolves.toBe(2);

    expect(runtime.logs).toEqual([]);
    expect(runtime.errors).toEqual([
      "Choose only one snapshot source: --db, --target, or --agent.",
    ]);
  });

  it("snapshots a realpathed named global database path", async () => {
    const runtime = createRuntimeCapture();
    const stateDir = path.join(workspaceDir, "state-root");
    const canonicalDbPath = path.join(stateDir, "state", "openclaw.sqlite");
    const realDbPath = path.join(workspaceDir, "real-state", "openclaw.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await createSqliteDatabase(realDbPath, "from-real-global");
    await fs.mkdir(path.dirname(canonicalDbPath), { recursive: true });
    const realRealpath = fs.realpath.bind(fs);
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(canonicalDbPath)) {
        return realDbPath;
      }
      return await realRealpath(candidate);
    });

    try {
      await expect(
        snapshotCreateCommand(
          { target: "global", repository: repositoryPath, json: true },
          runtime,
        ),
      ).resolves.toBe(0);
    } finally {
      realpathSpy.mockRestore();
    }

    const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshotPath?: string;
      manifest?: { database?: { id?: string; basename?: string } };
    };
    expect(createReport.manifest?.database).toMatchObject({
      id: "global",
      basename: "openclaw.sqlite",
    });
    const artifactPath = path.join(createReport.snapshotPath ?? "", "database.sqlite");
    const artifact = new DatabaseSync(artifactPath, { readOnly: true });
    try {
      expect(artifact.prepare("SELECT value FROM entries").all()).toEqual([
        { value: "from-real-global" },
      ]);
    } finally {
      artifact.close();
    }
    expect(runtime.errors).toEqual([]);
  });

  it("snapshots a realpathed explicit database path", async () => {
    const runtime = createRuntimeCapture();
    const linkDbPath = path.join(workspaceDir, "link", "source.sqlite");
    const realDbPath = path.join(workspaceDir, "real", "source.sqlite");
    const repositoryPath = path.join(workspaceDir, "snapshots");
    await createSqliteDatabase(realDbPath, "from-real-explicit");
    await fs.mkdir(path.dirname(linkDbPath), { recursive: true });
    const realRealpath = fs.realpath.bind(fs);
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(linkDbPath)) {
        return realDbPath;
      }
      return await realRealpath(candidate);
    });

    try {
      await expect(
        snapshotCreateCommand(
          {
            db: linkDbPath,
            id: "explicit-db",
            kind: "manual",
            repository: repositoryPath,
            json: true,
          },
          runtime,
        ),
      ).resolves.toBe(0);
    } finally {
      realpathSpy.mockRestore();
    }

    const createReport = JSON.parse(runtime.logs.shift() ?? "{}") as {
      snapshotPath?: string;
      manifest?: { database?: { id?: string; basename?: string } };
    };
    expect(createReport.manifest?.database).toMatchObject({
      id: "explicit-db",
      basename: "source.sqlite",
    });
    const artifactPath = path.join(createReport.snapshotPath ?? "", "database.sqlite");
    const artifact = new DatabaseSync(artifactPath, { readOnly: true });
    try {
      expect(artifact.prepare("SELECT value FROM entries").all()).toEqual([
        { value: "from-real-explicit" },
      ]);
    } finally {
      artifact.close();
    }
    expect(runtime.errors).toEqual([]);
  });
});

async function createSqliteDatabase(dbPath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE entries (value TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO entries (value) VALUES (?)").run(value);
  } finally {
    db.close();
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch((error: unknown) => {
      if (isNodeErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    });
}

async function readSortedDir(dirPath: string): Promise<string[]> {
  return (await fs.readdir(dirPath)).toSorted();
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function createRuntimeCapture(): RuntimeEnv & {
  readonly logs: string[];
  readonly errors: string[];
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
