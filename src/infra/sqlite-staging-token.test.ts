import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { acquireSqliteStagingToken, SqliteStagingRetiredError } from "./sqlite-staging-token.js";
import { readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";

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

// Windows prevents this replacement while the original descriptor remains retained.
it.runIf(process.platform !== "win32")(
  "refuses replacement of the captured staging token before any native transaction or pragma",
  () => {
    const directory = tempDirs.make("sqlite-staging-token-preopen-");
    const location = path.join(directory, "owner.sqlite");
    acquireSqliteStagingToken(directory, "create")();
    const originalIdentity = fs.lstatSync(location, { bigint: true });
    const expectedIdentity = {
      key: `file:${originalIdentity.dev}:${originalIdentity.ino}`,
      birthtime: readDatabaseIdentityBirthtime(originalIdentity),
    };
    const replacement = path.join(directory, "replacement.sqlite");
    const successor = openNodeSqliteDatabase(replacement);
    successor.exec("CREATE TABLE successor(value INTEGER); INSERT INTO successor VALUES(99)");
    successor.close();
    const replacementBytes = fs.readFileSync(replacement);
    const lstat = fs.lstatSync;
    let replaced = false;
    using observation = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const observed = Reflect.apply(lstat, fs, args);
      if (!replaced && args[0] === location && args[1]?.bigint === true) {
        fs.renameSync(location, path.join(directory, "original.sqlite"));
        fs.renameSync(replacement, location);
        replaced = true;
      }
      return observed;
    });
    using exec = vi.spyOn(DatabaseSync.prototype, "exec");
    using prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    let failure: unknown;
    try {
      acquireSqliteStagingToken(directory, "read", { expectedIdentity });
    } catch (error) {
      failure = error;
    }
    expect(replaced).toBe(true);
    observation.mockRestore();
    const entered = [...exec.mock.calls, ...prepare.mock.calls].filter(([sql]) =>
      /^(?:BEGIN|PRAGMA)\b/iu.test(sql.trim()),
    );
    expect(entered).toEqual([]);
    expect(fs.readFileSync(location)).toEqual(replacementBytes);
    expect(failure).toMatchObject({
      message: "SQLite staging database changed before native open",
    });
  },
);
