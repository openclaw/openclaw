import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  currentSqliteOperationTiming,
  withSqliteReaderOwner,
} from "../infra/sqlite-reader-lifecycle.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantineFailure,
  recordOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import { readPersistedQuarantineRow } from "./openclaw-quarantine-store.test-support.js";
import { resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function createFixture() {
  const root = tempDirs.make("openclaw-quarantine-transaction-");
  const env = { OPENCLAW_STATE_DIR: root };
  const pathname = path.join(root, "agent.sqlite");
  fs.writeFileSync(pathname, "");
  const record = () => {
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        path: pathname,
        kind: "agent",
        reason: "fixture setup",
      }),
    ).toBe(true);
    expect(clearOpenClawDatabaseQuarantine(pathname, { env })).toBe(true);
  };
  record();
  return { env, pathname, record, storePath: resolveQuarantineStorePath(env) };
}

it.each([0, 1])("counts quarantine initialization from version %s once", (version) => {
  const root = tempDirs.make("openclaw-quarantine-initialization-");
  const env = { OPENCLAW_STATE_DIR: root };
  const pathname = path.join(root, "agent.sqlite");
  if (version === 1) {
    const storePath = resolveQuarantineStorePath(env);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const database = nodeSqlite.openNodeSqliteDatabase(storePath);
    try {
      database.exec(`
        CREATE TABLE quarantined_databases (
          path TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL, writer_app_version TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    } finally {
      database.close();
    }
  }
  const record = () =>
    withSqliteReaderOwner({ operation: "quarantine.record", ownerKind: "worker" }, () => {
      expect(
        recordOpenClawDatabaseQuarantine({
          env,
          path: pathname,
          kind: "agent",
          reason: "synthetic initialization",
        }),
      ).toBe(true);
      return currentSqliteOperationTiming()?.transactions.count;
    });
  // Initialization and the decision each begin once; an admitted store only writes the decision.
  expect(record()).toBe(2);
  expect(record()).toBe(1);
  expect(readPersistedQuarantineRow(pathname, { env })).toMatchObject({
    reason: "synthetic initialization",
  });
});

it("retains quarantine decisions across closed handles and publishes record and clear", () => {
  const fixture = createFixture();
  fixture.record();
  const open = nodeSqlite.openNodeSqliteDatabase;
  const timeouts: unknown[] = [];
  const statements: string[] = [];
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === fixture.storePath) {
      timeouts.push(database.prepare("PRAGMA busy_timeout").get()?.timeout);
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
  expect(
    readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, { env: fixture.env }),
  ).toBeUndefined();
  const readDecision = () => {
    const observation = observeSqliteReadSql(
      nodeSqlite.requireNodeSqlite().StatementSync.prototype,
    );
    try {
      const result = readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, {
        env: fixture.env,
      });
      expect(observation.queries).toEqual([]);
      return result;
    } finally {
      observation.restore();
    }
  };
  expect(readDecision()).toBeUndefined();
  expect(
    recordOpenClawDatabaseQuarantine({
      env: fixture.env,
      path: fixture.pathname,
      kind: "agent",
      reason: "synthetic verified damage",
    }),
  ).toBe(true);
  expect(readDecision()).toMatchObject({
    name: "SqliteIntegrityError",
    message: expect.stringContaining("synthetic verified damage"),
  });
  expect(clearOpenClawDatabaseQuarantine(fixture.pathname, { env: fixture.env })).toBe(true);
  expect(readDecision()).toBeUndefined();
  expect(timeouts).toEqual([5_000, 5_000]);
  expect(statements.some((sql) => /\bPRAGMA\s+busy_timeout\s*=/i.test(sql))).toBe(false);
  expect(statements.filter((sql) => /\bPRAGMA\s+user_version\b|CREATE TABLE/i.test(sql))).toEqual(
    [],
  );
});

it("keeps quarantine decisions scoped to their recorded pathname", () => {
  const fixture = createFixture();
  const alias = `${fixture.pathname}.alias`;
  fs.linkSync(fixture.pathname, alias);
  expect(
    recordOpenClawDatabaseQuarantine({
      env: fixture.env,
      path: fixture.pathname,
      kind: "agent",
      reason: "canonical path is quarantined",
    }),
  ).toBe(true);
  const read = (pathname: string) =>
    readOpenClawDatabaseQuarantineFailure("agent", pathname, { env: fixture.env });
  expect(read(alias)).toBeUndefined();
  expect(read(fixture.pathname)).toMatchObject({
    name: "SqliteIntegrityError",
    message: expect.stringContaining("canonical path is quarantined"),
  });
  expect(clearOpenClawDatabaseQuarantine(alias, { env: fixture.env })).toBe(true);
  expect(read(fixture.pathname)).toMatchObject({
    name: "SqliteIntegrityError",
    message: expect.stringContaining("canonical path is quarantined"),
  });
});

it("validates a replaced quarantine store once across closed handles", () => {
  const fixture = createFixture();
  fs.renameSync(fixture.storePath, `${fixture.storePath}.original`);
  fs.copyFileSync(`${fixture.storePath}.original`, fixture.storePath);
  const open = nodeSqlite.openNodeSqliteDatabase;
  const statements: string[] = [];
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === fixture.storePath) {
      const prepare = database.prepare.bind(database);
      const exec = database.exec.bind(database);
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
  fixture.record();
  expect(statements.filter((sql) => /\bPRAGMA\s+user_version\b/i.test(sql))).toHaveLength(1);
  expect(statements.filter((sql) => /CREATE TABLE/i.test(sql))).toHaveLength(0);
  statements.length = 0;
  fixture.record();
  expect(statements.filter((sql) => /\bPRAGMA\s+user_version\b|CREATE TABLE/i.test(sql))).toEqual(
    [],
  );
});

it.each([
  { version: 0, error: undefined },
  { version: 2, error: "no such table: quarantined_databases" },
  { version: 3, error: "uses newer schema version 3" },
])("preserves version $version missing-table cleanup outcomes", ({ version, error }) => {
  const root = tempDirs.make("openclaw-quarantine-empty-");
  const env = { OPENCLAW_STATE_DIR: root };
  const pathname = path.join(root, "agent.sqlite");
  const storePath = resolveQuarantineStorePath(env);
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

it("refreshes schema facts after DDL and still reads fresh quarantine decisions", () => {
  const fixture = createFixture();
  expect(
    recordOpenClawDatabaseQuarantine({
      env: fixture.env,
      path: fixture.pathname,
      kind: "agent",
      reason: "legacy decision",
    }),
  ).toBe(true);
  const database = nodeSqlite.openNodeSqliteDatabase(fixture.storePath);
  const observation = observeSqliteReadSql(nodeSqlite.requireNodeSqlite().StatementSync.prototype);
  try {
    database.exec(
      "PRAGMA user_version = 1; UPDATE quarantined_databases SET verified_generation = 'invalid'",
    );
    expect(
      readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, {
        env: fixture.env,
        fresh: true,
      }),
    ).toMatchObject({ name: "SqliteIntegrityError" });
    database.exec("PRAGMA user_version = 2");
    expect(
      readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, {
        env: fixture.env,
        fresh: true,
      }),
    ).toBeUndefined();
    database.exec(
      "UPDATE quarantined_databases SET verified_generation = NULL, reason = 'updated decision'",
    );
    expect(
      readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, {
        env: fixture.env,
        fresh: true,
      }),
    ).toMatchObject({ message: expect.stringContaining("updated decision") });
    expect(observation.queries.filter((sql) => /^PRAGMA user_version$/iu.test(sql))).toHaveLength(
      2,
    );
    expect(
      observation.queries.filter((sql) => sql.includes("FROM quarantined_databases")),
    ).toHaveLength(3);
  } finally {
    observation.restore();
    database.close();
  }
});

it("discards a clean-close seal when clearing a decision with no quarantine store", () => {
  const root = tempDirs.make("openclaw-quarantine-clear-seal-");
  const pathname = path.join(root, "agent.sqlite");
  fs.writeFileSync(`${pathname}.seal`, "previous verification");
  expect(clearOpenClawDatabaseQuarantine(pathname, { env: { OPENCLAW_STATE_DIR: root } })).toBe(
    true,
  );
  expect(fs.existsSync(`${pathname}.seal`)).toBe(false);
});

it.each(["record", "clear"] as const)(
  "preserves the recorded quarantine when its %s transaction fails",
  (operation) => {
    const fixture = createFixture();
    const quarantine = { env: fixture.env, path: fixture.pathname, kind: "agent" as const };
    expect(recordOpenClawDatabaseQuarantine({ ...quarantine, reason: "original" })).toBe(true);
    const before = readPersistedQuarantineRow(fixture.pathname, { env: fixture.env });
    const database = nodeSqlite.openNodeSqliteDatabase(fixture.storePath);
    try {
      database.exec(`CREATE TRIGGER fail_quarantine BEFORE ${operation === "record" ? "INSERT" : "DELETE"}
        ON quarantined_databases BEGIN SELECT RAISE(ROLLBACK, 'quarantine write failed'); END`);
    } finally {
      database.close();
    }
    const result =
      operation === "record"
        ? recordOpenClawDatabaseQuarantine({ ...quarantine, reason: "replacement" })
        : clearOpenClawDatabaseQuarantine(fixture.pathname, { env: fixture.env });
    expect(result).toBe(false);
    expect(readPersistedQuarantineRow(fixture.pathname, { env: fixture.env })).toEqual(before);
    expect(
      readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, { env: fixture.env }),
    ).toMatchObject({ message: expect.stringContaining("original") });
  },
);
