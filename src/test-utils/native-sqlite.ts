import { DatabaseSync } from "node:sqlite";
import type { EngineConnection } from "../infra/sql-connection.js";

/** SQLite-specific fixtures must prove native capabilities before exercising them. */
export function requireNativeSqliteDatabase(database: EngineConnection): DatabaseSync {
  if (!(database instanceof DatabaseSync)) {
    throw new Error("This fixture requires a native SQLite database");
  }
  return database;
}
