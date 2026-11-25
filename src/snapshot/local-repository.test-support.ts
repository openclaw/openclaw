import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as directoryDurability from "@openclaw/fs-safe/durability";
import { expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPrivateSqliteDirectory } from "../infra/sqlite-private-directory.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import { hashSnapshotArtifact, readSnapshotManifest } from "./manifest.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotResult,
} from "./snapshot-provider.js";

type Publication = Parameters<typeof directoryDurability.publishFileExclusive>[0];
export function interceptPublication(
  action: (options: Publication) => Promise<void>,
  after = false,
  holdSource = false,
) {
  const publish = directoryDurability.publishFileExclusive;
  vi.spyOn(directoryDurability, "publishFileExclusive").mockImplementation(async (options) => {
    // Keep a replaced source inode live through publication so its ID cannot be reused.
    const heldSource = holdSource ? await fs.open(options.sourcePath, "r") : undefined;
    try {
      if (!after) {
        await action(options);
      }
      const published = await publish(options);
      if (after) {
        await action(options);
      }
      return published;
    } finally {
      await heldSource?.close();
    }
  });
}
export function interceptOpen(
  action: (
    pathname: string,
    flags: Parameters<typeof fs.open>[1],
    handle: Awaited<ReturnType<typeof fs.open>>,
  ) => Promise<void>,
) {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (pathname, flags, mode) => {
    const handle = await open(pathname, flags, mode);
    await action(String(pathname), flags, handle);
    return handle;
  });
}

export function createGenericDatabase(
  databasePath: string,
  options: { userVersion?: number; values?: string[]; wal?: boolean } = {},
): void {
  withDatabase(databasePath, (database) => {
    database.exec(`
      ${options.wal ? "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;" : ""}
      PRAGMA user_version = ${options.userVersion ?? 7};
      CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    `);
    const insert = database.prepare("INSERT INTO entries (value) VALUES (?)");
    (options.values ?? ["one"]).forEach((value) => insert.run(value));
  });
}

export function withDatabase<T>(
  databasePath: string,
  action: (database: DatabaseSync) => T,
  options: { readOnly?: boolean } = {},
): T {
  const sqlite = requireNodeSqlite();
  using database = new sqlite.DatabaseSync(databasePath, options);
  return action(database);
}

export const expectMissing = (filePath: string) =>
  expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });

export const readGenericValues = (databasePath: string): unknown[] =>
  withDatabase(
    databasePath,
    (database) => database.prepare("SELECT value FROM entries ORDER BY id").all(),
    { readOnly: true },
  );

export const createGenericSnapshot = (
  provider: ReturnType<typeof createLocalSqliteSnapshotProvider>,
  sourcePath: string,
  id: string,
): Promise<SnapshotResult> =>
  provider.create({ path: sourcePath, identity: { role: "generic", id } });

export async function refreshArtifactManifest(result: SnapshotResult): Promise<void> {
  const { sha256, sizeBytes } = await hashSnapshotArtifact(result.ref.path);
  const manifest = await readSnapshotManifest(result.ref.path);
  await fs.writeFile(
    path.join(result.ref.path, SNAPSHOT_MANIFEST_FILENAME),
    `${JSON.stringify({ ...manifest, artifact: { ...manifest.artifact, sha256, sizeBytes } }, null, 2)}\n`,
  );
}

export function useLocalRepositoryFixtures(
  registerCleanup: Parameters<typeof useAutoCleanupTempDirTracker>[0],
) {
  const tempDirs = useAutoCleanupTempDirTracker(registerCleanup);

  async function createTempDir(): Promise<string> {
    let tempDir = tempDirs.make("openclaw-snapshot-repository-");
    if (process.platform === "win32") {
      tempDir = path.join(tempDir, "private");
      await createPrivateSqliteDirectory(tempDir);
    }
    return tempDir;
  }

  async function createGenericRepositoryFixture(
    options: {
      database?: Parameters<typeof createGenericDatabase>[1];
      now?: () => Date;
      useValidationRoot?: boolean;
    } = {},
  ) {
    const tempDir = await createTempDir();
    const paths = {
      tempDir,
      sourcePath: path.join(tempDir, "source.sqlite"),
      repositoryPath: path.join(tempDir, "snapshots"),
      restorePath: path.join(tempDir, "restore", "source.sqlite"),
      validationRootPath: path.join(tempDir, "validation"),
    };
    createGenericDatabase(paths.sourcePath, options.database);
    if (options.useValidationRoot) {
      await fs.mkdir(paths.validationRootPath, { mode: 0o700 });
      await fs.chmod(paths.validationRootPath, 0o700);
    }
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: paths.repositoryPath,
      ...(options.useValidationRoot ? { validationRootPath: paths.validationRootPath } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    return {
      ...paths,
      provider,
      create: (id = "test") => createGenericSnapshot(provider, paths.sourcePath, id),
    };
  }

  async function createGenericSnapshotFixture(
    options: Parameters<typeof createGenericRepositoryFixture>[0] = {},
  ) {
    const fixture = await createGenericRepositoryFixture(options);
    const snapshot = await fixture.create();
    return {
      ...fixture,
      snapshot,
      file: (name = SNAPSHOT_SQLITE_FILENAME) => path.join(snapshot.ref.path, name),
      verify: () => fixture.provider.verify(snapshot.ref),
      restore: (target = fixture.restorePath) =>
        fixture.provider.restoreFresh(snapshot.ref, target),
    };
  }

  async function pendingSnapshot() {
    const fixture = await createGenericSnapshotFixture();
    const pendingPath = path.join(fixture.snapshot.ref.path, ".pending");
    await fs.writeFile(pendingPath, "");
    return { ...fixture, pendingPath };
  }

  async function stagingFixture(mode = 0o700, sharedMode?: number) {
    const { tempDir, sourcePath, repositoryPath } = await createGenericRepositoryFixture();
    const sharedPath = path.join(tempDir, "shared");
    const validationRootPath = path.join(sharedPath, "validation");
    const restoreParentPath = path.join(sharedPath, "restore");
    for (const directory of [validationRootPath, restoreParentPath]) {
      await fs.mkdir(directory, { recursive: true, mode });
      await fs.chmod(directory, mode);
    }
    if (sharedMode !== undefined) {
      await fs.chmod(sharedPath, sharedMode);
    }
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath, validationRootPath });
    const snapshot = await createGenericSnapshot(provider, sourcePath, "test");
    return {
      provider,
      snapshot,
      sharedPath,
      validationRootPath,
      restorePath: path.join(restoreParentPath, "source.sqlite"),
    };
  }

  return {
    createTempDir,
    createGenericRepositoryFixture,
    createGenericSnapshotFixture,
    pendingSnapshot,
    stagingFixture,
  };
}
