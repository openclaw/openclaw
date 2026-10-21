import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPrivateSqliteDirectory } from "../infra/sqlite-private-directory.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import type { SnapshotResult } from "./snapshot-provider.js";

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

export async function withRestoredSpies<T>(
  spies: { mockRestore: () => void }[],
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
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
    return {
      provider: createLocalSqliteSnapshotProvider({
        repositoryPath: paths.repositoryPath,
        ...(options.useValidationRoot ? { validationRootPath: paths.validationRootPath } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
      ...paths,
    };
  }

  async function createGenericSnapshotFixture(
    id: string,
    options: Parameters<typeof createGenericRepositoryFixture>[0] = {},
  ) {
    const fixture = await createGenericRepositoryFixture(options);
    return {
      ...fixture,
      snapshot: await createGenericSnapshot(fixture.provider, fixture.sourcePath, id),
    };
  }

  return { createTempDir, createGenericRepositoryFixture, createGenericSnapshotFixture };
}
