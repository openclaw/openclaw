import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { RuntimeEnv } from "../runtime.js";
import { backupRestoreCommand } from "./backup-restore.js";

let tempDir: string;

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
}

async function createSqliteDb(dbPath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE sample (value TEXT NOT NULL);");
    db.prepare("INSERT INTO sample (value) VALUES (?)").run(value);
  } finally {
    db.close();
  }
}

function readSqliteValue(dbPath: string): string | undefined {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM sample").get() as { value?: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

async function createBackupArchive(params: {
  archivePath: string;
  sourceStateDir: string;
  restoredStateDir: string;
}): Promise<void> {
  const archiveRoot = "2026-03-09T00-00-00-000Z-openclaw-backup";
  const assetArchivePath = `${archiveRoot}/payload/posix${params.sourceStateDir}`;
  const snapshotArchivePath = `${assetArchivePath}/state/openclaw.sqlite`;
  const archiveBuildDir = path.join(tempDir, "archive-build");
  const payloadPath = path.join(archiveBuildDir, ...assetArchivePath.split("/"));
  await fs.cp(params.restoredStateDir, payloadPath, { recursive: true });
  await fs.writeFile(
    path.join(archiveBuildDir, archiveRoot, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: params.sourceStateDir,
            archivePath: assetArchivePath,
          },
        ],
        databaseSnapshots: [
          {
            sourcePath: path.join(params.sourceStateDir, "state", "openclaw.sqlite"),
            archivePath: snapshotArchivePath,
            integrity: "ok",
          },
        ],
        skipped: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await tar.c({ cwd: archiveBuildDir, file: params.archivePath, gzip: true }, [archiveRoot]);
}

describe("backupRestoreCommand", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("requires --yes unless dry-run is used", async () => {
    const runtime = createRuntime();
    const result = await backupRestoreCommand(runtime, {
      archive: path.join(tempDir, "missing.tar.gz"),
    });

    expect(result).toBeUndefined();
    expect(runtime.error).toHaveBeenCalledWith(
      "Backup restore requires --yes. Preview first with --dry-run.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("previews restore paths without changing files", async () => {
    const sourceStateDir = path.join(tempDir, "state");
    const restoredStateDir = path.join(tempDir, "snapshot-state");
    const archivePath = path.join(tempDir, "backup.tar.gz");
    await fs.mkdir(sourceStateDir, { recursive: true });
    await fs.writeFile(path.join(sourceStateDir, "state.txt"), "current\n");
    await fs.mkdir(restoredStateDir, { recursive: true });
    await fs.writeFile(path.join(restoredStateDir, "state.txt"), "restored\n");
    await createSqliteDb(path.join(restoredStateDir, "state", "openclaw.sqlite"), "restored");
    await createBackupArchive({ archivePath, sourceStateDir, restoredStateDir });

    const runtime = createRuntime();
    const result = await backupRestoreCommand(runtime, { archive: archivePath, dryRun: true });

    expect(result?.dryRun).toBe(true);
    expect(result?.databaseSnapshotCount).toBe(1);
    expect(result?.restoredAssets).toEqual([
      expect.objectContaining({ kind: "state", sourcePath: sourceStateDir, status: "planned" }),
    ]);
    expect(await fs.readFile(path.join(sourceStateDir, "state.txt"), "utf8")).toBe("current\n");
  });

  it("restores verified SQLite snapshots to their recorded source paths", async () => {
    const sourceStateDir = path.join(tempDir, "state");
    const restoredStateDir = path.join(tempDir, "snapshot-state");
    const archivePath = path.join(tempDir, "backup.tar.gz");
    await fs.mkdir(sourceStateDir, { recursive: true });
    await fs.writeFile(path.join(sourceStateDir, "state.txt"), "current\n");
    await createSqliteDb(path.join(sourceStateDir, "state", "openclaw.sqlite"), "current");
    await fs.mkdir(restoredStateDir, { recursive: true });
    await fs.writeFile(path.join(restoredStateDir, "state.txt"), "restored\n");
    await createSqliteDb(path.join(restoredStateDir, "state", "openclaw.sqlite"), "restored");
    await createBackupArchive({ archivePath, sourceStateDir, restoredStateDir });

    const runtime = createRuntime();
    const result = await backupRestoreCommand(runtime, { archive: archivePath, yes: true });

    expect(result?.dryRun).toBe(false);
    expect(result?.restoredAssets).toEqual([
      expect.objectContaining({ kind: "state", sourcePath: sourceStateDir, status: "restored" }),
    ]);
    expect(await fs.readFile(path.join(sourceStateDir, "state.txt"), "utf8")).toBe("restored\n");
    expect(readSqliteValue(path.join(sourceStateDir, "state", "openclaw.sqlite"))).toBe("restored");
  });
});
