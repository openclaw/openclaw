import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import { hashSnapshotArtifact, parseSnapshotManifest, readSnapshotManifest } from "./manifest.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotManifest,
  type SnapshotResult,
} from "./snapshot-provider.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-snapshot-repository-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { recursive: true })));
});

function createGenericDatabase(
  databasePath: string,
  options: { userVersion?: number; values?: string[]; wal?: boolean } = {},
): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      ${options.wal ? "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;" : ""}
      PRAGMA user_version = ${options.userVersion ?? 7};
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const insert = database.prepare("INSERT INTO entries (value) VALUES (?)");
    for (const value of options.values ?? ["one"]) {
      insert.run(value);
    }
  } finally {
    database.close();
  }
}

function createGlobalDatabase(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
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
    `);
    database
      .prepare("INSERT INTO schema_meta VALUES ('primary', 'agent', ?, ?)")
      .run(OPENCLAW_AGENT_SCHEMA_VERSION, agentId);
  } finally {
    database.close();
  }
}

function createUnsafeIndexDrift(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX records_value ON records(indexed_value);
      INSERT INTO records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
      PRAGMA writable_schema = ON;
    `);
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX records_value ON records(alternate_value)' WHERE name = 'records_value'",
      )
      .run();
    const schemaVersion = Number(
      Object.values(database.prepare("PRAGMA schema_version").get() as Record<string, unknown>)[0],
    );
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

async function rewriteManifest(
  result: SnapshotResult,
  mutate: (manifest: SnapshotManifest) => SnapshotManifest,
): Promise<void> {
  const manifestPath = path.join(result.ref.path, SNAPSHOT_MANIFEST_FILENAME);
  const manifest = await readSnapshotManifest(result.ref.path);
  await fs.writeFile(manifestPath, `${JSON.stringify(mutate(manifest), null, 2)}\n`);
}

async function refreshArtifactManifest(result: SnapshotResult): Promise<void> {
  const digest = await hashSnapshotArtifact(result.ref.path);
  await rewriteManifest(result, (manifest) => ({
    ...manifest,
    artifact: {
      ...manifest.artifact,
      sha256: digest.sha256,
      sizeBytes: digest.sizeBytes,
    },
  }));
}

describe("local SQLite snapshot repository", () => {
  it("creates, lists, verifies, and fresh-restores committed WAL state", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "source.sqlite");
    const sqlite = requireNodeSqlite();
    const source = new sqlite.DatabaseSync(sourcePath);
    try {
      source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        PRAGMA user_version = 42;
        CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO entries (value) VALUES ('checkpointed');
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO entries (value) VALUES ('committed-in-wal');
      `);
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath,
        now: () => new Date("2026-07-12T14:00:00.000Z"),
      });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "test-database" },
      });

      expect(snapshot.manifest).toMatchObject({
        schemaVersion: 1,
        createdAt: "2026-07-12T14:00:00.000Z",
        database: {
          role: "generic",
          id: "test-database",
          basename: "source.sqlite",
          userVersion: 42,
        },
        artifact: {
          path: SNAPSHOT_SQLITE_FILENAME,
        },
      });
      expect(snapshot.manifest.artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
      await expect(provider.verify(snapshot.ref)).resolves.toEqual({
        ok: true,
        manifest: snapshot.manifest,
      });
      await expect(provider.list()).resolves.toEqual([snapshot]);
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).resolves.toEqual({
        ok: true,
        manifest: snapshot.manifest,
      });
      await expect(fs.readFile(restorePath)).resolves.toEqual(
        await fs.readFile(path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME)),
      );
      expect((await fs.readdir(repositoryPath)).every((name) => !name.startsWith(".tmp-"))).toBe(
        true,
      );
      await expect(fs.readdir(path.dirname(restorePath))).resolves.toEqual(["source.sqlite"]);
    } finally {
      source.close();
    }

    const restored = new sqlite.DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM entries ORDER BY id").all()).toEqual([
        { value: "checkpointed" },
        { value: "committed-in-wal" },
      ]);
      expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 42 });
    } finally {
      restored.close();
    }
    if (process.platform !== "win32") {
      expect((await fs.stat(repositoryPath)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(restorePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("sorts snapshots newest first and ignores incomplete staging directories", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const dates = [new Date("2026-07-12T14:00:00.000Z"), new Date("2026-07-12T14:01:00.000Z")];
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath,
      now: () => dates.shift() ?? new Date("invalid"),
    });
    const first = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "test-database" },
    });
    const second = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "test-database" },
    });
    await fs.mkdir(path.join(repositoryPath, ".tmp-interrupted"));
    await fs.mkdir(path.join(repositoryPath, "interrupted-final"));
    await fs.writeFile(path.join(repositoryPath, "interrupted-final", ".pending"), "");
    await fs.mkdir(path.join(repositoryPath, "empty-final"));

    await expect(provider.list()).resolves.toEqual([second, first]);
  });

  it("never replaces a snapshot directory raced into place", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath,
      now: () => new Date("2026-07-12T14:00:00.000Z"),
    });
    const originalMkdir = fs.mkdir.bind(fs);
    let racedPath: string | undefined;
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (directoryPath, options) => {
      const resolvedPath = path.resolve(String(directoryPath));
      if (
        path.dirname(resolvedPath) === repositoryPath &&
        !path.basename(resolvedPath).startsWith(".tmp-")
      ) {
        racedPath = resolvedPath;
        await originalMkdir(resolvedPath, options);
        await fs.writeFile(path.join(resolvedPath, "keep"), "racer");
      }
      return await originalMkdir(directoryPath, options);
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "directory-race" },
        }),
      ).rejects.toThrow(/directory already exists/u);
    } finally {
      mkdirSpy.mockRestore();
    }
    expect(racedPath).toBeDefined();
    await expect(fs.readFile(path.join(racedPath!, "keep"), "utf8")).resolves.toBe("racer");
  });

  it("rejects an artifact changed after entering the final directory", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const originalLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (
        path.basename(String(target)) === SNAPSHOT_MANIFEST_FILENAME &&
        !path.basename(path.dirname(String(target))).startsWith(".tmp-")
      ) {
        await fs.appendFile(
          path.join(path.dirname(String(target)), SNAPSHOT_SQLITE_FILENAME),
          "changed-after-final-move",
        );
      }
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "final-directory-race" },
        }),
      ).rejects.toThrow(/size mismatch/u);
      await expect(provider.list()).resolves.toEqual([]);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("cleans a linked entry when post-link inspection fails", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const originalLink = fs.link.bind(fs);
    const originalLstat = fs.lstat.bind(fs);
    let linkedArtifactPath: string | undefined;
    let failedInspection = false;
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (
        path.basename(String(target)) === SNAPSHOT_SQLITE_FILENAME &&
        !path.basename(path.dirname(String(target))).startsWith(".tmp-")
      ) {
        linkedArtifactPath = path.resolve(String(target));
      }
    });
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (filePath) => {
      if (
        linkedArtifactPath &&
        !failedInspection &&
        path.resolve(String(filePath)) === linkedArtifactPath
      ) {
        failedInspection = true;
        throw Object.assign(new Error("post-link inspection failed"), { code: "EIO" });
      }
      return await originalLstat(filePath);
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "post-link-inspection" },
        }),
      ).rejects.toThrow(/post-link inspection failed/u);
      await expect(provider.list()).resolves.toEqual([]);
      await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it("never overwrites a file raced into the final snapshot directory", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const originalLink = fs.link.bind(fs);
    let racedPath: string | undefined;
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      const targetPath = path.resolve(String(target));
      if (
        path.basename(targetPath) === SNAPSHOT_SQLITE_FILENAME &&
        path.dirname(targetPath) !== repositoryPath &&
        !path.basename(path.dirname(targetPath)).startsWith(".tmp-")
      ) {
        racedPath = targetPath;
        await fs.writeFile(targetPath, "racer", { flag: "wx" });
      }
      await originalLink(source, target);
    });

    try {
      await expect(
        provider.create({
          path: sourcePath,
          identity: { role: "generic", id: "entry-race" },
        }),
      ).rejects.toThrow(/EEXIST/u);
    } finally {
      linkSpy.mockRestore();
    }
    expect(racedPath).toBeDefined();
    await expect(fs.readFile(racedPath!, "utf8")).resolves.toBe("racer");
  });

  it("sanitizes transient global delivery rows and enforces the global owner", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "openclaw.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGlobalDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "global" },
    });
    const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
    expect((await fs.readFile(artifactPath)).includes("do-not-restore")).toBe(false);
    const sqlite = requireNodeSqlite();
    const artifact = new sqlite.DatabaseSync(artifactPath, { readOnly: true });
    try {
      expect(
        artifact.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
      ).toEqual({ count: 0 });
    } finally {
      artifact.close();
    }

    const wrongRolePath = path.join(tempDir, "wrong-role.sqlite");
    createAgentDatabase(wrongRolePath, "main");
    const wrongRole = new sqlite.DatabaseSync(wrongRolePath);
    wrongRole.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
    wrongRole.close();
    await expect(
      provider.create({ path: wrongRolePath, identity: { role: "global" } }),
    ).rejects.toThrow(/expected global/u);
  });

  it("enforces the exact agent owner and canonical agent id", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "openclaw-agent.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createAgentDatabase(sourcePath, "worker-1");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    await expect(
      provider.create({
        path: sourcePath,
        identity: { role: "agent", agentId: "worker-2" },
      }),
    ).rejects.toThrow(/belongs to agent worker-1/u);
    await expect(
      provider.create({
        path: sourcePath,
        identity: { role: "agent", agentId: "Worker-1" },
      }),
    ).rejects.toThrow(/must be canonical/u);
    await expect(
      provider.create({
        path: sourcePath,
        identity: { role: "agent", agentId: "worker-1" },
      }),
    ).resolves.toMatchObject({
      manifest: {
        database: {
          role: "agent",
          agentId: "worker-1",
          userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      },
    });
  });

  it("rejects foreign-key violations and unsafe index definitions at creation", async () => {
    const tempDir = await createTempDir();
    const repositoryPath = path.join(tempDir, "snapshots");
    const foreignKeyPath = path.join(tempDir, "foreign-key.sqlite");
    const sqlite = requireNodeSqlite();
    const foreignKeyDatabase = new sqlite.DatabaseSync(foreignKeyPath);
    try {
      foreignKeyDatabase.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER REFERENCES parents(id)
        );
        INSERT INTO children VALUES (1, 99);
      `);
    } finally {
      foreignKeyDatabase.close();
    }
    const unsafeIndexPath = path.join(tempDir, "unsafe-index.sqlite");
    createUnsafeIndexDrift(unsafeIndexPath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    await expect(
      provider.create({
        path: foreignKeyPath,
        identity: { role: "generic", id: "foreign-key" },
      }),
    ).rejects.toThrow(/foreign_key_check failed/u);
    await expect(
      provider.create({
        path: unsafeIndexPath,
        identity: { role: "generic", id: "unsafe-index" },
      }),
    ).rejects.toThrow(/integrity_check failed|malformed database schema/iu);
    await expect(provider.list()).resolves.toEqual([]);
  });

  it("detects artifact hash, user_version, and unsafe-index drift after creation", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    const hashSnapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "hash" },
    });
    await fs.appendFile(path.join(hashSnapshot.ref.path, SNAPSHOT_SQLITE_FILENAME), "tamper");
    await expect(provider.verify(hashSnapshot.ref)).rejects.toThrow(/size mismatch/u);

    const versionSnapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "version" },
    });
    const sqlite = requireNodeSqlite();
    const versionDatabase = new sqlite.DatabaseSync(
      path.join(versionSnapshot.ref.path, SNAPSHOT_SQLITE_FILENAME),
    );
    versionDatabase.exec("PRAGMA user_version = 99;");
    versionDatabase.close();
    await refreshArtifactManifest(versionSnapshot);
    await expect(provider.verify(versionSnapshot.ref)).rejects.toThrow(/user_version mismatch/u);

    const unsafeSnapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "unsafe" },
    });
    const unsafePath = path.join(unsafeSnapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
    const unsafeDatabase = new sqlite.DatabaseSync(unsafePath);
    try {
      unsafeDatabase.exec(`
        CREATE TABLE indexed_records (
          id INTEGER PRIMARY KEY,
          indexed_value TEXT NOT NULL,
          alternate_value TEXT NOT NULL
        );
        CREATE INDEX indexed_records_value ON indexed_records(indexed_value);
        INSERT INTO indexed_records (indexed_value, alternate_value)
        VALUES ('alpha', 'zeta'), ('beta', 'eta');
        PRAGMA writable_schema = ON;
      `);
      unsafeDatabase
        .prepare(
          "UPDATE sqlite_schema SET sql = 'CREATE INDEX indexed_records_value ON indexed_records(alternate_value)' WHERE name = 'indexed_records_value'",
        )
        .run();
      const schemaVersion = Number(
        Object.values(
          unsafeDatabase.prepare("PRAGMA schema_version").get() as Record<string, unknown>,
        )[0],
      );
      unsafeDatabase.exec(
        `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`,
      );
    } finally {
      unsafeDatabase.close();
    }
    await refreshArtifactManifest(unsafeSnapshot);
    await expect(provider.verify(unsafeSnapshot.ref)).rejects.toThrow(
      /integrity_check failed|malformed database schema/iu,
    );
  });

  it("never overwrites an existing target or orphan SQLite sidecar", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "source.sqlite");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "restore" },
    });
    await fs.mkdir(path.dirname(restorePath), { recursive: true });
    await fs.writeFile(restorePath, "keep");

    await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
      /restore path already exists/u,
    );
    await expect(fs.readFile(restorePath, "utf8")).resolves.toBe("keep");

    await fs.unlink(restorePath);
    await fs.writeFile(`${restorePath}-wal`, "keep-wal");
    await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
      /restore path already exists/u,
    );
    await expect(fs.readFile(`${restorePath}-wal`, "utf8")).resolves.toBe("keep-wal");
    await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when fresh restore cannot publish atomically", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "source.sqlite");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "atomic-restore" },
    });
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));

    try {
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
        /requires hard-link support/u,
      );
      await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      linkSpy.mockRestore();
    }
  });

  it("rejects restore targets inside the snapshot repository", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "repository-boundary" },
    });

    await expect(
      provider.restoreFresh(snapshot.ref, path.join(repositoryPath, "restored.sqlite")),
    ).rejects.toThrow(/outside snapshot repository/u);
    await expect(
      provider.restoreFresh(snapshot.ref, path.join(snapshot.ref.path, "restored.sqlite")),
    ).rejects.toThrow(/outside snapshot repository/u);
    await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
  });

  it.runIf(process.platform !== "win32")(
    "binds restore to the exact artifact bytes recorded by the manifest",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const restorePath = path.join(tempDir, "restore", "source.sqlite");
      createGenericDatabase(sourcePath);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "verified-bytes" },
      });
      const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
      const originalOpen = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (
          flags === "wx+" &&
          path.basename(String(filePath)) === SNAPSHOT_SQLITE_FILENAME &&
          path.basename(path.dirname(String(filePath))).startsWith(".tmp-restore-")
        ) {
          const sqlite = requireNodeSqlite();
          const database = new sqlite.DatabaseSync(artifactPath);
          database.prepare("INSERT INTO entries (value) VALUES (?)").run("raced");
          database.close();
        }
        return handle;
      });

      try {
        await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
          /hash mismatch|size mismatch/u,
        );
        await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        openSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "never publishes replacement bytes when the pinned staging pathname changes",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const restorePath = path.join(tempDir, "restore", "source.sqlite");
      createGenericDatabase(sourcePath, { values: ["original"] });
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "pinned-staging" },
      });
      const originalOpen = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        if (
          flags === "wx+" &&
          path.basename(path.dirname(String(filePath))).startsWith(".sqlite-publish-")
        ) {
          const stagingEntry = (await fs.readdir(repositoryPath)).find((entry) =>
            entry.startsWith(".tmp-restore-"),
          );
          if (!stagingEntry) {
            throw new Error("restore staging directory was not created");
          }
          const stagedPath = path.join(repositoryPath, stagingEntry, SNAPSHOT_SQLITE_FILENAME);
          await fs.unlink(stagedPath);
          createGenericDatabase(stagedPath, { values: ["replacement"] });
        }
        return await originalOpen(filePath, flags, mode);
      });

      let restored = false;
      try {
        await provider.restoreFresh(snapshot.ref, restorePath);
        restored = true;
      } catch (error) {
        expect(String(error)).toMatch(/file changed while reading/u);
      } finally {
        openSpy.mockRestore();
      }
      if (!restored) {
        await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      const sqlite = requireNodeSqlite();
      const database = new sqlite.DatabaseSync(restorePath, { readOnly: true });
      try {
        expect(database.prepare("SELECT value FROM entries").all()).toEqual([
          { value: "original" },
        ]);
      } finally {
        database.close();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes only its restored target when a sidecar races publication",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      const restorePath = path.join(tempDir, "restore", "source.sqlite");
      createGenericDatabase(sourcePath);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "restore-race" },
      });
      const originalLink = fs.link.bind(fs);
      const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
        await originalLink(source, target);
        if (path.resolve(String(target)) === restorePath) {
          await fs.writeFile(`${restorePath}-wal`, "racer");
        }
      });

      try {
        await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(
          /unexpected sidecar/u,
        );
        await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.readFile(`${restorePath}-wal`, "utf8")).resolves.toBe("racer");
      } finally {
        linkSpy.mockRestore();
      }
    },
  );

  it("rejects snapshots outside the configured repository and unexpected contents", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "boundary" },
    });

    await expect(provider.verify({ path: tempDir })).rejects.toThrow(/immediate child/u);
    await fs.writeFile(path.join(snapshot.ref.path, `${SNAPSHOT_SQLITE_FILENAME}-wal`), "orphan");
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/unexpected entry/u);
    await expect(provider.list()).rejects.toThrow(/unexpected entry/u);
  });

  it("bounds manifest reads before parsing untrusted snapshot metadata", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGenericDatabase(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "generic", id: "bounded-manifest" },
    });
    await fs.writeFile(
      path.join(snapshot.ref.path, SNAPSHOT_MANIFEST_FILENAME),
      Buffer.alloc(1024 * 1024 + 1, 0x20),
    );

    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/1048576 bytes/u);
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked repositories, snapshot files, restore parents, and hardlinked artifacts",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const realRepositoryPath = path.join(tempDir, "real-snapshots");
      const repositoryLink = path.join(tempDir, "snapshot-link");
      createGenericDatabase(sourcePath);
      await fs.mkdir(realRepositoryPath);
      await fs.symlink(realRepositoryPath, repositoryLink);
      const linkedProvider = createLocalSqliteSnapshotProvider({
        repositoryPath: repositoryLink,
      });
      await expect(
        linkedProvider.create({
          path: sourcePath,
          identity: { role: "generic", id: "symlink-repository" },
        }),
      ).rejects.toThrow(/symlink|Invalid path/iu);

      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath: realRepositoryPath,
      });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "links" },
      });
      const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
      const externalArtifact = path.join(tempDir, "external.sqlite");
      await fs.link(artifactPath, externalArtifact);
      await expect(provider.verify(snapshot.ref)).rejects.toThrow(/hardlink/iu);
      await fs.unlink(externalArtifact);

      const manifestPath = path.join(snapshot.ref.path, SNAPSHOT_MANIFEST_FILENAME);
      const realManifest = path.join(tempDir, "manifest.json");
      await fs.rename(manifestPath, realManifest);
      await fs.symlink(realManifest, manifestPath);
      await expect(provider.verify(snapshot.ref)).rejects.toThrow(/regular file|symlink/iu);

      await fs.unlink(manifestPath);
      await fs.rename(realManifest, manifestPath);
      const realRestoreParent = path.join(tempDir, "real-restore");
      const restoreParentLink = path.join(tempDir, "restore-link");
      await fs.mkdir(realRestoreParent);
      await fs.symlink(realRestoreParent, restoreParentLink);
      await expect(
        provider.restoreFresh(snapshot.ref, path.join(restoreParentLink, "restored.sqlite")),
      ).rejects.toThrow(/symlink|Invalid path/iu);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects repository restore targets reached through another filesystem spelling",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const repositoryPath = path.join(tempDir, "snapshots");
      createGenericDatabase(sourcePath);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
      const snapshot = await provider.create({
        path: sourcePath,
        identity: { role: "generic", id: "canonical-boundary" },
      });
      const aliasRoot = path.join(tempDir, "alias");
      await fs.symlink(tempDir, aliasRoot);
      const aliasRepositoryPath = path.join(aliasRoot, "snapshots");
      const aliasProvider = createLocalSqliteSnapshotProvider({
        repositoryPath: aliasRepositoryPath,
      });
      const aliasSnapshot = {
        path: path.join(aliasRepositoryPath, path.basename(snapshot.ref.path)),
      };

      await expect(
        aliasProvider.restoreFresh(aliasSnapshot, path.join(repositoryPath, "restored.sqlite")),
      ).rejects.toThrow(/outside snapshot repository/u);
      await expect(provider.verify(snapshot.ref)).resolves.toMatchObject({ ok: true });
    },
  );
});

describe("snapshot manifest parser", () => {
  const manifestPath = "/snapshots/snapshot/manifest.json";
  const snapshotId = "snapshot";
  const validManifest: SnapshotManifest = {
    schemaVersion: 1,
    snapshotId,
    createdAt: "2026-07-12T14:00:00.000Z",
    database: {
      role: "agent",
      agentId: "worker-1",
      basename: "openclaw-agent.sqlite",
      userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    artifact: {
      path: SNAPSHOT_SQLITE_FILENAME,
      sha256: "a".repeat(64),
      sizeBytes: 4096,
    },
  };

  it.each([
    ["unknown top-level field", { ...validManifest, extra: true }, /fields must be exactly/u],
    ["wrong directory id", validManifest, /does not match directory/u, "other"],
    [
      "noncanonical timestamp",
      { ...validManifest, createdAt: "2026-07-12T14:00:00Z" },
      /not canonical/u,
    ],
    [
      "artifact path traversal",
      { ...validManifest, artifact: { ...validManifest.artifact, path: "../database.sqlite" } },
      /artifact\.path must be database\.sqlite/u,
    ],
    [
      "prefixed digest",
      {
        ...validManifest,
        artifact: { ...validManifest.artifact, sha256: `sha256:${"a".repeat(64)}` },
      },
      /sha256 is invalid/u,
    ],
    [
      "noncanonical agent id",
      { ...validManifest, database: { ...validManifest.database, agentId: "Worker-1" } },
      /agentId is invalid/u,
    ],
    [
      "unsafe basename",
      { ...validManifest, database: { ...validManifest.database, basename: "../db.sqlite" } },
      /basename is invalid/u,
    ],
    [
      "out-of-range user version",
      { ...validManifest, database: { ...validManifest.database, userVersion: 2 ** 31 } },
      /userVersion is invalid/u,
    ],
    [
      "zero-byte artifact",
      { ...validManifest, artifact: { ...validManifest.artifact, sizeBytes: 0 } },
      /sizeBytes is invalid/u,
    ],
  ])("rejects %s", (_name, value, error, expectedId = snapshotId) => {
    expect(() => parseSnapshotManifest(value, manifestPath, expectedId)).toThrow(error);
  });
});
