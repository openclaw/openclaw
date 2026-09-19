import fs from "node:fs/promises";
import { expect } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";

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
