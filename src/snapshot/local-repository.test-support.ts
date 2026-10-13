import fs from "node:fs/promises";
import path from "node:path";
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
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const insert = database.prepare("INSERT INTO entries (value) VALUES (?)");
    for (const value of options.values ?? ["one"]) {
      insert.run(value);
    }
  });
}

export function withDatabase<T>(
  databasePath: string,
  action: (database: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>) => T,
  options: { readOnly?: boolean } = {},
): T {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath, options);
  try {
    return action(database);
  } finally {
    database.close();
  }
}

export async function withRestoredSpies<T>(
  spies: { mockRestore: () => void }[],
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

export async function expectMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

export function readGenericValues(databasePath: string): unknown[] {
  return withDatabase(
    databasePath,
    (database) => database.prepare("SELECT value FROM entries ORDER BY id").all(),
    { readOnly: true },
  );
}

export function createGenericSnapshot(
  provider: ReturnType<typeof createLocalSqliteSnapshotProvider>,
  sourcePath: string,
  id: string,
): Promise<SnapshotResult> {
  return provider.create({ path: sourcePath, identity: { role: "generic", id } });
}

export function useLocalRepositoryFixtures(
  registerCleanup: Parameters<typeof useAutoCleanupTempDirTracker>[0],
) {
  const tempDirs = useAutoCleanupTempDirTracker(registerCleanup);

  async function createTempDir(): Promise<string> {
    const tempDir = tempDirs.make("openclaw-snapshot-repository-");
    if (process.platform === "win32") {
      const privateTempDir = path.join(tempDir, "private");
      await createPrivateSqliteDirectory(privateTempDir);
      return privateTempDir;
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
    const sourcePath = path.join(tempDir, "source.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "source.sqlite");
    const validationRootPath = path.join(tempDir, "validation");
    createGenericDatabase(sourcePath, options.database);
    if (options.useValidationRoot) {
      await fs.mkdir(validationRootPath, { mode: 0o700 });
      await fs.chmod(validationRootPath, 0o700);
    }
    return {
      provider: createLocalSqliteSnapshotProvider({
        repositoryPath,
        ...(options.useValidationRoot ? { validationRootPath } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
      repositoryPath,
      restorePath,
      sourcePath,
      tempDir,
      validationRootPath,
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
