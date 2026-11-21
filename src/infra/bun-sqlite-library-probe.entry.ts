import { createRequire } from "node:module";

type SqliteDatabase = {
  query(sql: string): { get(): { version: string; omitted: number } };
  close(): void;
};

try {
  const candidate = process.argv[2];
  if (!candidate || process.argv.length !== 3) {
    throw new Error("Expected one SQLite library path");
  }
  const require = createRequire(import.meta.url);
  // SAFETY: The parent runs this entry under Bun, whose builtin provides this Database API.
  const { Database } = require("bun:sqlite") as {
    Database: { new (path: string): SqliteDatabase; setCustomSQLite(path: string): void };
  };
  Database.setCustomSQLite(candidate);
  const database = new Database(":memory:");
  let facts: { version: string; omitted: number };
  try {
    facts = database
      .query(
        "SELECT sqlite_version() AS version, sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted",
      )
      .get();
  } finally {
    database.close();
  }
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      version: facts.version,
      extensionLoadingSupported: facts.omitted === 0,
    }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 512),
    }),
  );
  process.exitCode = 1;
}
