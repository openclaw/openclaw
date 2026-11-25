import type { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";

export function useSqliteSchemaTestFixture() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const databases: DatabaseSync[] = [];

  function openDatabase(
    schema = "CREATE TABLE original (id INTEGER); PRAGMA user_version = 1;",
    admitted = true,
    location = ":memory:",
  ) {
    const database = openNodeSqliteDatabase(location);
    databases.push(database);
    database.exec(schema);
    enableNodeSqliteKyselyStatementCache(database);
    if (admitted) {
      admitSqliteSchema(database);
    }
    return database;
  }

  afterEach(() => {
    for (const database of databases.splice(0)) {
      if (database.isOpen) {
        database.close();
      }
    }
  });

  return { tempDirs, openDatabase, databases };
}
