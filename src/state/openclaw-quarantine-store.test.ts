import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { retainSqliteDatabaseAdmissionLocation } from "../infra/sqlite-database-admission.js";
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
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function createFixture(initialize = true) {
  const root = tempDirs.make("openclaw-quarantine-transaction-");
  const env = { OPENCLAW_STATE_DIR: root };
  const pathname = path.join(root, "agent.sqlite");
  const clear = () => {
    expect(clearOpenClawDatabaseQuarantine(pathname, { env })).toBe(true);
  };
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
  const { env, pathname, storePath } = createFixture(false);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  {
    using database = nodeSqlite.openNodeSqliteDatabase(storePath);
    if (version === 1) {
      database.exec(`
        CREATE TABLE quarantined_databases (
          path TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL, writer_app_version TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    }
  }
  const clear = () =>
    withSqliteReaderOwner({ operation: "quarantine.clear", ownerKind: "worker" }, () => {
      expect(clearOpenClawDatabaseQuarantine(pathname, { env })).toBe(true);
      return currentSqliteOperationTiming()?.transactions.count;
    });
  // Initialization and clearing each begin once; an admitted store only clears the decision.
  expect(clear()).toBe(2);
  expect(clear()).toBe(1);
  expect(readPersistedQuarantineRow(pathname, { env })).toBeUndefined();
});

it.each([false, true])(
  "retains a loaded decision (quarantined=%s) across final close",
  (quarantined) => {
    const fixture = createFixture();
    if (quarantined) {
      fixture.seed("synthetic verified damage");
    }
    const pathname = quarantined ? fixture.pathname : `${fixture.pathname}.unrecorded`;
    const expected = quarantined
      ? expect.objectContaining({
          name: "SqliteIntegrityError",
          message: expect.stringContaining("synthetic verified damage"),
        })
      : undefined;
    expect(fixture.read(pathname)).toEqual(expected);
    const timeouts: unknown[] = [];
    const statements = observeStore(fixture.storePath, (database) => {
      timeouts.push(database.prepare("PRAGMA busy_timeout").get()?.timeout);
    });
    const readDecision = () => {
      const observation = observeSqliteReadSql(
        nodeSqlite.requireNodeSqlite().StatementSync.prototype,
      );
      try {
        const result = fixture.read(pathname);
        expect(observation.queries).toEqual([]);
        return result;
      } finally {
        observation.restore();
      }
    };
    expect(readDecision()).toEqual(expected);
    if (quarantined) {
      fixture.clear();
      expect(readDecision()).toBeUndefined();
    }
    expect(timeouts).toEqual(quarantined ? [5_000] : []);
    expect(statements.some((sql) => /\bPRAGMA\s+busy_timeout\s*=/i.test(sql))).toBe(false);
    expect(statements.filter((sql) => /\bPRAGMA\s+user_version\b|CREATE TABLE/i.test(sql))).toEqual(
      [],
    );
  },
);

it("keeps quarantine decisions scoped to their recorded pathname", () => {
  const fixture = createFixture();
  const alias = `${fixture.pathname}.alias`;
  fs.linkSync(fixture.pathname, alias);
  fixture.seed("canonical path is quarantined");
  const read = fixture.read;
  const failure = expect.objectContaining({
    name: "SqliteIntegrityError",
    message: expect.stringContaining("canonical path is quarantined"),
  });
  expect(read(alias)).toBeUndefined();
  expect(read(fixture.pathname)).toEqual(failure);
  expect(clearOpenClawDatabaseQuarantine(alias, { env: fixture.env })).toBe(true);
  expect(read(fixture.pathname)).toEqual(failure);
});

it("validates a replaced quarantine store once while an admitted sibling remains open", () => {
  const fixture = createFixture();
  fs.renameSync(fixture.storePath, `${fixture.storePath}.original`);
  fs.copyFileSync(`${fixture.storePath}.original`, fixture.storePath);
  // Keep quarantine facts alive without adding generic catalog admission and its DDL refresh.
  retainSqliteDatabaseAdmissionLocation(fixture.storePath);
  const sibling = nodeSqlite.openNodeSqliteDatabase(fixture.storePath);
  try {
    const statements = observeStore(fixture.storePath);
    fixture.clear();
    expect(statements.filter((sql) => /\bPRAGMA\s+user_version\b/i.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => /CREATE TABLE/i.test(sql))).toHaveLength(0);
    statements.length = 0;
    fixture.clear();
    expect(statements.filter((sql) => /\bPRAGMA\s+user_version\b|CREATE TABLE/i.test(sql))).toEqual(
      [],
    );
  } finally {
    sibling.close();
  }
});

it.each([
  { version: 0, error: undefined },
  { version: 2, error: "no such table: quarantined_databases" },
  { version: 3, error: "uses newer schema version 3" },
])("preserves version $version missing-table cleanup outcomes", ({ version, error }) => {
  const { env, pathname, storePath } = createFixture(false);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const empty = nodeSqlite.openNodeSqliteDatabase(storePath);
  empty.exec(`PRAGMA user_version = ${version}`);
  empty.close();
  expect(readOpenClawDatabaseQuarantineFailure("agent", pathname, { env })).toBeUndefined();
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
    expect(() =>
      readOpenClawDatabaseQuarantineFailure("agent", pathname, { env, fresh: true }),
    ).toThrow(
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
    for (const close of closeReaders) {
      close();
    }
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
    {
      using database = nodeSqlite.openNodeSqliteDatabase(fixture.storePath);
      database.exec(`CREATE TRIGGER fail_quarantine BEFORE DELETE
        ON quarantined_databases BEGIN SELECT RAISE(${failure}, 'quarantine write failed'); END`);
    }
    const result = clearOpenClawDatabaseQuarantine(fixture.pathname, { env: fixture.env });
    expect(result).toBe(false);
    expect(fixture.persisted()).toEqual(before);
    expect(fixture.read()).toMatchObject({ message: expect.stringContaining("original") });
  },
);
