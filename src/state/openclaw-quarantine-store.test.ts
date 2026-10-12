import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
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

it("reuses admitted quarantine schema while publishing decision changes", () => {
  const fixture = createFixture();
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
  const readDecision = () => {
    const observation = observeSqliteReadSql(
      nodeSqlite.requireNodeSqlite().StatementSync.prototype,
    );
    try {
      const result = readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, {
        env: fixture.env,
      });
      // The opening spy contributes one timeout observation; the decision contributes one read.
      expect(observation.queries).toHaveLength(2);
      return result;
    } finally {
      observation.restore();
    }
  };
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
  expect(timeouts).toEqual([5_000, 5_000, 5_000, 5_000]);
  expect(statements.some((sql) => /\bPRAGMA\s+busy_timeout\s*=/i.test(sql))).toBe(false);
  expect(statements.filter((sql) => /\bPRAGMA\s+user_version\b|CREATE TABLE/i.test(sql))).toEqual(
    [],
  );
});

it.each(["initialized", "empty"] as const)(
  "observes quarantine recorded by another process after a clean read of an %s store",
  (store) => {
    const fixture = createFixture();
    if (store === "empty") {
      fs.renameSync(fixture.storePath, `${fixture.storePath}.initialized`);
      fs.writeFileSync(fixture.storePath, "");
    }
    const read = () =>
      readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, { env: fixture.env });
    expect(read()).toBeUndefined();
    const identity = fs.statSync(fixture.pathname, { bigint: true });
    const storeIdentity = fs.statSync(fixture.storePath, { bigint: true });
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
       const database = new DatabaseSync(process.argv[1]);
       database.exec("CREATE TABLE IF NOT EXISTS quarantined_databases (path TEXT PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL, writer_app_version TEXT NOT NULL, verified_generation TEXT); PRAGMA user_version=2");
       database.prepare("INSERT INTO quarantined_databases (path, kind, reason, quarantined_at, writer_app_version) VALUES (?, 'agent', 'synthetic external corruption', 1, 'fixture')").run(process.argv[2]);
       database.close();`,
        fixture.storePath,
        fixture.pathname,
      ],
      { stdio: "pipe" },
    );
    const current = fs.statSync(fixture.pathname, { bigint: true });
    expect({ dev: current.dev, ino: current.ino }).toEqual({
      dev: identity.dev,
      ino: identity.ino,
    });
    const currentStore = fs.statSync(fixture.storePath, { bigint: true });
    expect({ dev: currentStore.dev, ino: currentStore.ino }).toEqual({
      dev: storeIdentity.dev,
      ino: storeIdentity.ino,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(read()).toMatchObject({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("synthetic external corruption"),
      });
    }
  },
);

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

it("validates a replaced quarantine store once without repeating its installation DDL", () => {
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
    expect(() => readOpenClawDatabaseQuarantineFailure("agent", pathname, { env })).toThrow(
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
  expect(
    recordOpenClawDatabaseQuarantine({
      env: fixture.env,
      path: fixture.pathname,
      kind: "agent",
      reason: "legacy decision",
    }),
  ).toBe(true);
  const database = nodeSqlite.openNodeSqliteDatabase(fixture.storePath);
  try {
    database.exec(
      "PRAGMA user_version = 1; UPDATE quarantined_databases SET verified_generation = 'invalid'",
    );
    expect(
      readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, { env: fixture.env }),
    ).toMatchObject({ name: "SqliteIntegrityError" });
    database.exec("PRAGMA user_version = 2");
    expect(
      readOpenClawDatabaseQuarantineFailure("agent", fixture.pathname, { env: fixture.env }),
    ).toBeUndefined();
  } finally {
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
  },
);
