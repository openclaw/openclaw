import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { acquireSqliteStagingToken, SqliteStagingRetiredError } from "./sqlite-staging-token.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps read custody after creator release and rejects late readers after retirement", () => {
  const directory = tempDirs.make("sqlite-staging-token-");
  const creator = acquireSqliteStagingToken(directory, "create");
  const reader = acquireSqliteStagingToken(directory, "read");
  try {
    creator();
    expect(() => acquireSqliteStagingToken(directory, "reclaim")).toThrow(/locked|busy/i);
  } finally {
    reader();
    creator();
  }
  const retirement = acquireSqliteStagingToken(directory, "reclaim");
  retirement(true);
  expect(() => acquireSqliteStagingToken(directory, "read")).toThrow(SqliteStagingRetiredError);
  expect(() => acquireSqliteStagingToken(directory, "create")).toThrow(SqliteStagingRetiredError);
  // Interrupted payload removal can reacquire an already committed retirement.
  acquireSqliteStagingToken(directory, "reclaim")(true);
});

it("refuses an existing WAL token even when acquired by a creator", () => {
  const directory = tempDirs.make("sqlite-staging-token-wal-");
  const database = openNodeSqliteDatabase(path.join(directory, "owner.sqlite"));
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE payload (value TEXT)");
  database.close();
  expect(() => acquireSqliteStagingToken(directory, "create")).toThrow(
    "SQLite snapshot token journal mode is unknown",
  );
});
