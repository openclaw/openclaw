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

it("hands off captured identities without retiring or blocking late staging admission", () => {
  const directory = tempDirs.make("sqlite-staging-token-handoff-");
  const location = path.join(directory, "owner.sqlite");
  using close = vi.spyOn(DatabaseSync.prototype, "close");
  const creator = acquireSqliteStagingToken(directory, "create", { exclusiveCreate: true });
  close.mockClear();
  const directoryIdentity = fs.lstatSync(directory, { bigint: true });
  const tokenIdentity = fs.lstatSync(location, { bigint: true });
  const tokenBytes = fs.readFileSync(location);
  try {
    {
      using exec = vi.spyOn(DatabaseSync.prototype, "exec");
      using prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const identity = creator.releaseForRetirement();
      expect(identity).toEqual({
        directory: { dev: directoryIdentity.dev.toString(), ino: directoryIdentity.ino.toString() },
        token: {
          key: `file:${tokenIdentity.dev}:${tokenIdentity.ino}`,
          birthtime: readDatabaseIdentityBirthtime(tokenIdentity),
        },
      });
      expect(exec.mock.calls).toEqual([["ROLLBACK"]]);
      expect(prepare).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      using lstat = vi.spyOn(fs, "lstatSync");
      expect(creator.releaseForRetirement()).toBe(identity);
      expect(lstat).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    }
    expect(fs.readFileSync(location)).toEqual(tokenBytes);
    acquireSqliteStagingToken(directory, "read")();
    acquireSqliteStagingToken(directory, "create")();
    acquireSqliteStagingToken(directory, "reclaim")(true);
    expect(() => acquireSqliteStagingToken(directory, "read")).toThrow(SqliteStagingRetiredError);
    expect(() => acquireSqliteStagingToken(directory, "create")).toThrow(SqliteStagingRetiredError);
  } finally {
    creator();
  }
});

it("retries a failed native close before returning the retirement identity", () => {
  const directory = tempDirs.make("sqlite-staging-token-handoff-close-");
  const failure = new Error("Fixture native close failed");
  using close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => {
    throw failure;
  });
  const creator = acquireSqliteStagingToken(directory, "create", { exclusiveCreate: true });
  using exec = vi.spyOn(DatabaseSync.prototype, "exec");
  try {
    expect(() => creator.releaseForRetirement()).toThrow(failure);
    expect(close).toHaveBeenCalledTimes(1);
    expect(creator.releaseForRetirement().token.key).toMatch(/^file:/u);
    expect(close).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls).toEqual([["ROLLBACK"]]);
    creator.releaseForRetirement();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    creator();
  }
});

// Windows prevents this replacement while the original descriptor remains retained.
it.skipIf(process.platform === "win32").each(["directory", "token"] as const)(
  "refuses a replacement %s before releasing retirement custody",
  (replaced) => {
    const root = tempDirs.make("sqlite-staging-token-handoff-replacement-");
    const directory = path.join(root, "stage");
    const location = path.join(directory, "owner.sqlite");
    fs.mkdirSync(directory);
    using close = vi.spyOn(DatabaseSync.prototype, "close");
    const creator = acquireSqliteStagingToken(directory, "create");
    close.mockClear();
    fs.renameSync(replaced === "directory" ? directory : location, path.join(root, "original"));
    if (replaced === "directory") {
      fs.mkdirSync(directory);
    }
    fs.writeFileSync(location, "replacement bytes");
    try {
      using exec = vi.spyOn(DatabaseSync.prototype, "exec");
      expect(() => creator.releaseForRetirement()).toThrow(
        "SQLite staging ownership changed before retirement",
      );
      expect(exec).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(fs.readFileSync(location, "utf8")).toBe("replacement bytes");
    } finally {
      creator();
    }
  },
);

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
