import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";

let workspaceDir: string;

describe("snapshot provider", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(tmpdir(), "snapshot-provider-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("creates a verified restorable snapshot from a WAL-mode SQLite database", async () => {
    const dbPath = path.join(workspaceDir, "source.sqlite");
    const repoPath = path.join(workspaceDir, "snapshots");
    const restorePath = path.join(workspaceDir, "restore", "source.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        PRAGMA user_version = 42;
        CREATE TABLE entries (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO entries (value) VALUES ('before-wal');
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO entries (value) VALUES ('committed-in-wal');
      `);

      await expect(fs.access(`${dbPath}-wal`)).resolves.toBeUndefined();
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath: repoPath,
        now: () => new Date("2026-06-18T22:00:00.000Z"),
      });
      const result = await provider.create({
        path: dbPath,
        id: "test-db",
        kind: "test",
      });

      expect(result.manifest).toMatchObject({
        schemaVersion: 1,
        database: {
          id: "test-db",
          kind: "test",
          basename: "source.sqlite",
          userVersion: 42,
        },
        artifact: {
          path: "database.sqlite",
        },
      });
      expect(result.manifest.snapshotId).toMatch(
        /^2026-06-18T22-00-00-000Z-source\.sqlite-[0-9a-f-]{36}$/,
      );
      expect(result.manifest.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.manifest.artifact.sizeBytes).toBeGreaterThan(0);
      await expect(
        fs.access(path.join(result.ref.path, "database.sqlite-wal")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      const artifact = new DatabaseSync(path.join(result.ref.path, "database.sqlite"), {
        readOnly: true,
      });
      try {
        expect(artifact.prepare("PRAGMA user_version").get()).toEqual({
          user_version: result.manifest.database.userVersion,
        });
      } finally {
        artifact.close();
      }

      const verified = await provider.verify(result.ref);
      expect(verified).toMatchObject({
        ok: true,
        integrityCheck: ["ok"],
      });
      await provider.restore(result.ref, restorePath);
    } finally {
      db.close();
    }

    const restored = new DatabaseSync(restorePath, { readOnly: true });
    try {
      const rows = restored.prepare("SELECT value FROM entries ORDER BY id").all() as Array<{
        value: string;
      }>;
      expect(rows.map((row) => row.value)).toEqual(["before-wal", "committed-in-wal"]);
      expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 42 });
    } finally {
      restored.close();
    }
  });

  it("rejects a snapshot when its artifact hash no longer matches the manifest", async () => {
    const dbPath = path.join(workspaceDir, "source.sqlite");
    const repoPath = path.join(workspaceDir, "snapshots");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE entries (value TEXT); INSERT INTO entries (value) VALUES ('one');");
    } finally {
      db.close();
    }
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: repoPath,
      now: () => new Date("2026-06-18T22:01:00.000Z"),
    });
    const result = await provider.create({ path: dbPath });
    await fs.appendFile(path.join(result.ref.path, "database.sqlite"), "tamper");

    await expect(provider.verify(result.ref)).rejects.toThrow("Snapshot artifact size mismatch");
  });

  it("does not list incomplete snapshots left by failed create attempts", async () => {
    const repoPath = path.join(workspaceDir, "snapshots");
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: repoPath,
      now: () => new Date("2026-06-18T22:02:00.000Z"),
    });

    await expect(
      provider.create({ path: path.join(workspaceDir, "missing.sqlite") }),
    ).rejects.toThrow();
    await fs.mkdir(path.join(repoPath, ".tmp-crashed-create"));

    await expect(provider.list?.()).resolves.toEqual([]);
  });

  it("accepts signed SQLite user_version values", async () => {
    const dbPath = path.join(workspaceDir, "source.sqlite");
    const repoPath = path.join(workspaceDir, "snapshots");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA user_version = -7; CREATE TABLE entries (value TEXT);");
    } finally {
      db.close();
    }
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: repoPath,
      now: () => new Date("2026-06-18T22:03:00.000Z"),
    });

    const result = await provider.create({ path: dbPath });
    expect(result.manifest.database.userVersion).toBe(-7);
    await expect(provider.verify(result.ref)).resolves.toMatchObject({
      ok: true,
      manifest: {
        database: {
          userVersion: -7,
        },
      },
    });
    await expect(provider.list?.()).resolves.toHaveLength(1);
  });

  it("creates unique snapshot ids for repeated snapshots in the same millisecond", async () => {
    const dbPath = path.join(workspaceDir, "source.sqlite");
    const repoPath = path.join(workspaceDir, "snapshots");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE entries (value TEXT);");
    } finally {
      db.close();
    }
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: repoPath,
      now: () => new Date("2026-06-18T22:04:00.000Z"),
    });

    const first = await provider.create({ path: dbPath });
    const second = await provider.create({ path: dbPath });

    expect(first.manifest.snapshotId).not.toBe(second.manifest.snapshotId);
    await expect(provider.list?.()).resolves.toHaveLength(2);
  });

  it("removes stale WAL sidecars before verifying a restored target", async () => {
    const dbPath = path.join(workspaceDir, "source.sqlite");
    const repoPath = path.join(workspaceDir, "snapshots");
    const restorePath = path.join(workspaceDir, "restore", "source.sqlite");
    const source = new DatabaseSync(dbPath);
    try {
      source.exec("CREATE TABLE entries (value TEXT); INSERT INTO entries VALUES ('snapshot');");
    } finally {
      source.close();
    }
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: repoPath,
      now: () => new Date("2026-06-18T22:05:00.000Z"),
    });
    const result = await provider.create({ path: dbPath });
    const sidecars = await createStaleWalSidecars(restorePath);
    await fs.mkdir(path.dirname(restorePath), { recursive: true });
    await fs.writeFile(`${restorePath}-wal`, sidecars.wal);
    if (sidecars.shm) {
      await fs.writeFile(`${restorePath}-shm`, sidecars.shm);
    }

    await provider.restore(result.ref, restorePath);

    await expect(fs.access(`${restorePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = new DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM entries").all()).toEqual([{ value: "snapshot" }]);
    } finally {
      restored.close();
    }
  });
});

async function createStaleWalSidecars(targetPath: string): Promise<{
  readonly wal: Buffer;
  readonly shm?: Buffer;
}> {
  const stalePath = path.join(path.dirname(targetPath), "stale.sqlite");
  await fs.mkdir(path.dirname(stalePath), { recursive: true });
  const stale = new DatabaseSync(stalePath);
  try {
    stale.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE entries (value TEXT);
      INSERT INTO entries VALUES ('stale-main');
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO entries VALUES ('stale-wal');
    `);
    return {
      wal: await fs.readFile(`${stalePath}-wal`),
      ...((await fileExists(`${stalePath}-shm`))
        ? { shm: await fs.readFile(`${stalePath}-shm`) }
        : {}),
    };
  } finally {
    stale.close();
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}
