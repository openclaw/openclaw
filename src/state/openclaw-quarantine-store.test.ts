import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  getSqliteDatabaseAdmissionIdentityForPath,
  retainSqliteDatabaseAdmissionLocation,
} from "../infra/sqlite-database-admission.js";
import {
  currentSqliteOperationTiming,
  withSqliteReaderOwner,
} from "../infra/sqlite-reader-lifecycle.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
} from "./openclaw-quarantine-store.js";
import {
  readPersistedQuarantineRow,
  seedOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.test-support.js";
import {
  closeRetainedOpenClawStateReadConnections,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const schemaSql = /\bPRAGMA\s+user_version\b|CREATE TABLE/i;

const integrityFailure = (reason: string) =>
  expect.objectContaining({
    name: "SqliteIntegrityError",
    message: expect.stringContaining(reason),
  });

function createFixture(initialize = true) {
  const root = tempDirs.make("openclaw-quarantine-transaction-");
  const env = { OPENCLAW_STATE_DIR: root };
  const pathname = path.join(root, "agent.sqlite");
  const clear = () => expect(clearOpenClawDatabaseQuarantine(pathname, { env })).toBe(true);
  if (initialize) {
    fs.writeFileSync(pathname, "");
    seedOpenClawDatabaseQuarantine({ env, path: pathname, kind: "agent", reason: "fixture setup" });
    clear();
  }
  return {
    env,
    pathname,
    clear,
    storePath: resolveQuarantineStorePath(env),
    seed: (reason: string) =>
      seedOpenClawDatabaseQuarantine({ env, path: pathname, kind: "agent", reason }),
    read: (target = pathname, fresh?: true) =>
      readOpenClawDatabaseQuarantineFailure("agent", target, { env, fresh }),
    persisted: () => readPersistedQuarantineRow(pathname, { env }),
    exec: (sql: string) => {
      fs.mkdirSync(path.dirname(resolveQuarantineStorePath(env)), { recursive: true });
      using database = nodeSqlite.openNodeSqliteDatabase(resolveQuarantineStorePath(env));
      database.exec(sql);
    },
  };
}

function observeStore(
  storePath: string,
  onOpen: (db: ReturnType<typeof nodeSqlite.openNodeSqliteDatabase>) => void = () => {},
) {
  const open = nodeSqlite.openNodeSqliteDatabase;
  const statements: string[] = [];
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === storePath) {
      onOpen(database);
      const exec = database.exec.bind(database);
      const prepare = database.prepare.bind(database);
      vi.spyOn(database, "prepare").mockImplementation((sql) => {
        statements.push(sql);
        return prepare(sql);
      });
      vi.spyOn(database, "exec").mockImplementation((sql) => {
        statements.push(sql);
        exec(sql);
      });
    }
    return database;
  });
  return statements;
}

it.each([0, 1])("counts quarantine initialization from version %s once", (version) => {
  const fixture = createFixture(false);
  const legacySchema = `CREATE TABLE quarantined_databases (
          path TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL, writer_app_version TEXT
        ) STRICT;
        PRAGMA user_version = 1;`;
  fixture.exec(version === 1 ? legacySchema : "");
  const clear = () =>
    withSqliteReaderOwner({ operation: "quarantine.clear", ownerKind: "worker" }, () => {
      fixture.clear();
      return currentSqliteOperationTiming()?.transactions.count;
    });
  expect([clear(), clear()]).toEqual([2, 1]);
  expect(fixture.persisted()).toBeUndefined();
});

it.each([false, true])("retains cached quarantine=%s after close", (quarantined) => {
  const fixture = createFixture();
  if (quarantined) {
    fixture.seed("synthetic verified damage");
  }
  const pathname = quarantined ? fixture.pathname : `${fixture.pathname}.unrecorded`;
  const expected = quarantined ? integrityFailure("synthetic verified damage") : undefined;
  expect(fixture.read(pathname)).toEqual(expected);
  const timeouts: unknown[] = [];
  const statements = observeStore(fixture.storePath, (database) => {
    timeouts.push(database.prepare("PRAGMA busy_timeout").get()?.timeout);
  });
  const readDecision = () => {
    const observation = observeSqliteReadSql(
      nodeSqlite.requireNodeSqlite().StatementSync.prototype,
    );
    const result = fixture.read(pathname);
    observation.restore();
    expect(observation.queries).toEqual([]);
    return result;
  };
  expect(readDecision()).toEqual(expected);
  if (quarantined) {
    fixture.clear();
    expect(readDecision()).toBeUndefined();
  }
  expect(timeouts).toEqual(quarantined ? [5_000] : []);
  expect(
    statements.filter((sql) =>
      /\bPRAGMA\s+(?:busy_timeout\s*=|user_version\b)|CREATE TABLE/i.test(sql),
    ),
  ).toEqual([]);
});

it("keeps quarantine decisions scoped to their recorded pathname", () => {
  const fixture = createFixture();
  const alias = `${fixture.pathname}.alias`;
  fs.linkSync(fixture.pathname, alias);
  fixture.seed("canonical path is quarantined");
  const failure = integrityFailure("canonical path is quarantined");
  expect(fixture.read(alias)).toBeUndefined();
  expect(fixture.read()).toEqual(failure);
  expect(clearOpenClawDatabaseQuarantine(alias, { env: fixture.env })).toBe(true);
  expect(fixture.read()).toEqual(failure);
});

it("retains quarantine admission with its reader while observing changes and final closure", () => {
  const fixture = createFixture();
  const { env, pathname, storePath } = fixture;
  const seed = nodeSqlite.openNodeSqliteDatabase(pathname);
  seed.exec("CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (1)");
  seed.close();
  const read = () =>
    withOpenClawStateReadOnlyLocation(
      ({ db }) => ({ db, value: db.prepare("SELECT value FROM sample").get()?.value }),
      pathname,
      pathname,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      storePath,
    );
  const identity = () => getSqliteDatabaseAdmissionIdentityForPath(storePath);
  const decision = () =>
    readOpenClawDatabaseQuarantineFailure("state", pathname, { env, refreshIdentity: true });
  try {
    read();
    const original = identity();
    expect(original).toEqual(expect.objectContaining({ key: expect.stringMatching(/^file:/u) }));
    for (let index = 0; index < 3; index++) {
      expect(decision()).toBeUndefined();
      expect(read().value).toBe(1);
      expect(identity()).toBe(original);
    }
    {
      using unavailable = vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("index unavailable"), { code: "EACCES" });
      });
      expect(decision()).toBeUndefined();
      expect(unavailable).toHaveBeenCalledOnce();
    }
    fixture.seed("changed");
    expect(decision()?.message).toContain("changed");
    fixture.clear();
    expect(decision()).toBeUndefined();
    fs.renameSync(storePath, `${storePath}.previous`);
    expect(decision()).toBeUndefined();
    expect(identity()).toBeUndefined();
    read();
    fixture.seed("replacement");
    expect(decision()?.message).toContain("replacement");
    const { db: database } = read();
    expect(identity()?.key).not.toBe(original?.key);
    expect(decision()?.message).toContain("replacement");
    {
      using close = vi.spyOn(database, "close").mockImplementationOnce(() => {
        throw new Error("native close failed");
      });
      expect(() => closeRetainedOpenClawStateReadConnections()).toThrow("native close failed");
      expect(close).toHaveBeenCalledOnce();
      expect(identity()).toBeDefined();
    }
    closeRetainedOpenClawStateReadConnections();
    expect(identity()).toBeUndefined();
  } finally {
    closeRetainedOpenClawStateReadConnections();
  }
});

it("validates a replaced quarantine store once while an admitted sibling remains open", () => {
  const fixture = createFixture();
  fs.renameSync(fixture.storePath, `${fixture.storePath}.original`);
  fs.copyFileSync(`${fixture.storePath}.original`, fixture.storePath);
  // Keep quarantine facts alive without adding generic catalog admission and its DDL refresh.
  retainSqliteDatabaseAdmissionLocation(fixture.storePath);
  using sibling = nodeSqlite.openNodeSqliteDatabase(fixture.storePath);
  const statements = observeStore(fixture.storePath);
  fixture.clear();
  expect(statements.filter((sql) => schemaSql.test(sql))).toEqual([
    expect.stringMatching(/\bPRAGMA\s+user_version\b/i),
  ]);
  statements.length = 0;
  fixture.clear();
  expect(statements.filter((sql) => schemaSql.test(sql))).toEqual([]);
  expect(sibling.isOpen).toBe(true);
});

it.each([
  { version: 0, error: undefined },
  { version: 2, error: "no such table: quarantined_databases" },
  { version: 3, error: "uses newer schema version 3" },
])("preserves version $version missing-table cleanup outcomes", ({ version, error }) => {
  const fixture = createFixture(false);
  fixture.exec(`PRAGMA user_version = ${version}`);
  expect(fixture.read()).toBeUndefined();
  const closeFailure = new Error("synthetic quarantine close failure");
  const closeReaders: Array<() => void> = [];
  const open = nodeSqlite.openNodeSqliteDatabase;
  const intercepted = vi
    .spyOn(nodeSqlite, "openNodeSqliteDatabase")
    .mockImplementation((...args) => {
      const database = open(...args);
      closeReaders.push(database.close.bind(database));
      vi.spyOn(database, "close").mockImplementation(() => {
        throw closeFailure;
      });
      return database;
    });
  try {
    expect(() => fixture.read(fixture.pathname, true)).toThrow(
      expect.objectContaining({
        name: "OpenClawQuarantineReadCleanupError",
        errors: [
          ...(error ? [expect.objectContaining({ message: expect.stringContaining(error) })] : []),
          closeFailure,
        ],
      }),
    );
  } finally {
    intercepted.mockRestore();
    closeReaders.forEach((close) => close());
  }
});

it("uses generation metadata only after its schema version admits it", () => {
  const fixture = createFixture();
  fixture.seed("legacy decision");
  using database = nodeSqlite.openNodeSqliteDatabase(fixture.storePath);
  database.exec(
    "PRAGMA user_version = 1; UPDATE quarantined_databases SET verified_generation = 'invalid'",
  );
  expect(fixture.read(fixture.pathname, true)).toMatchObject({ name: "SqliteIntegrityError" });
  database.exec("PRAGMA user_version = 2");
  expect(fixture.read(fixture.pathname, true)).toBeUndefined();
});

it("discards a clean-close seal when clearing a decision with no quarantine store", () => {
  const { pathname, clear } = createFixture(false);
  fs.writeFileSync(`${pathname}.seal`, "previous verification");
  clear();
  expect(fs.existsSync(`${pathname}.seal`)).toBe(false);
});

it.each(["ABORT", "ROLLBACK"] as const)(
  "preserves the recorded quarantine when clearing fails with %s",
  (failure) => {
    const fixture = createFixture();
    fixture.seed("original");
    const before = fixture.persisted();
    fixture.exec(`CREATE TRIGGER fail_quarantine BEFORE DELETE
        ON quarantined_databases BEGIN SELECT RAISE(${failure}, 'quarantine write failed'); END`);
    expect(clearOpenClawDatabaseQuarantine(fixture.pathname, { env: fixture.env })).toBe(false);
    expect(fixture.persisted()).toEqual(before);
    expect(fixture.read()).toMatchObject({ message: expect.stringContaining("original") });
  },
);
