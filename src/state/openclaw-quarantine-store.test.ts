import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as kyselySync from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  clearOpenClawAgentIntegrityVerification,
  clearOpenClawDatabaseQuarantine,
  markOpenClawAgentIntegrityClean,
  readOpenClawAgentIntegrityVerification,
  readOpenClawDatabaseQuarantineFailure,
  recordOpenClawAgentIntegrityVerification,
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
  const file = fs.statSync(pathname, { bigint: true });
  const identity = `${file.dev}:${file.ino}`;
  const record = () => {
    recordOpenClawAgentIntegrityVerification(pathname, env, identity);
    markOpenClawAgentIntegrityClean(pathname, env, identity);
  };
  record();
  return { env, pathname, record, storePath: resolveQuarantineStorePath(env) };
}

function failReceiptWrite(
  storePath: string,
  operation: "UPDATE" | "DELETE",
  failure: "full" | "rollback",
) {
  const database = nodeSqlite.openNodeSqliteDatabase(storePath);
  let pageCount: number;
  try {
    database.exec("CREATE TABLE failure_payload (value BLOB)");
    database.exec(`CREATE TRIGGER fail_receipt BEFORE ${operation}
      ON agent_integrity_verifications BEGIN
        ${
          failure === "full"
            ? "INSERT INTO failure_payload VALUES (zeroblob(65536))"
            : "SELECT RAISE(ROLLBACK, 'receipt write failed')"
        };
      END`);
    pageCount = Number(database.prepare("PRAGMA page_count").get()?.page_count);
  } finally {
    database.close();
  }
  if (failure === "full") {
    const open = nodeSqlite.openNodeSqliteDatabase;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const opened = open(...args);
      if (args[0] === storePath) {
        // Bound the real SQLite writer instead of filling the host filesystem.
        opened.exec(`PRAGMA max_page_count=${pageCount}`);
      }
      return opened;
    });
  }
}

it("sets the quarantine lock wait at open and reads each fresh decision in one statement", () => {
  const fixture = createFixture();
  const open = nodeSqlite.openNodeSqliteDatabase;
  const timeouts: unknown[] = [];
  const statements: string[] = [];
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === fixture.storePath) {
      timeouts.push(database.prepare("PRAGMA busy_timeout").get()?.timeout);
      const exec = database.exec.bind(database);
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

it.each([
  { operation: "consume", failure: "full" },
  { operation: "consume", failure: "rollback" },
  { operation: "clear", failure: "full" },
  { operation: "clear", failure: "rollback" },
] as const)("preserves the original $failure failure during receipt $operation", (params) => {
  const fixture = createFixture();
  const before = readOpenClawAgentIntegrityVerification(fixture.pathname, fixture.env);
  failReceiptWrite(
    fixture.storePath,
    params.operation === "consume" ? "UPDATE" : "DELETE",
    params.failure,
  );
  const execute = kyselySync.executeSqliteQuerySync;
  let primaryError: unknown;
  vi.spyOn(kyselySync, "executeSqliteQuerySync").mockImplementation((...args) => {
    try {
      return execute(...args);
    } catch (error) {
      primaryError = error;
      throw error;
    }
  });
  let observed: unknown;
  try {
    if (params.operation === "consume") {
      readOpenClawAgentIntegrityVerification(fixture.pathname, fixture.env, true);
    } else {
      clearOpenClawAgentIntegrityVerification(fixture.pathname, fixture.env);
    }
  } catch (error) {
    observed = error;
  }
  expect(primaryError).toMatchObject(
    params.failure === "full" ? { errcode: 13 } : { message: "receipt write failed" },
  );
  expect(observed).toBe(primaryError);
  expect(readOpenClawAgentIntegrityVerification(fixture.pathname, fixture.env)).toEqual(before);

  vi.restoreAllMocks();
  const database = nodeSqlite.openNodeSqliteDatabase(fixture.storePath);
  try {
    expect(database.prepare("SELECT * FROM failure_payload").all()).toEqual([]);
    database.exec("DROP TRIGGER fail_receipt");
  } finally {
    database.close();
  }
  clearOpenClawAgentIntegrityVerification(fixture.pathname, fixture.env);
  expect(readOpenClawAgentIntegrityVerification(fixture.pathname, fixture.env)).toBeUndefined();
});

it.each(["record", "clear"] as const)(
  "returns false and rolls back paired rows when quarantine %s fails",
  (operation) => {
    const fixture = createFixture();
    const quarantine = { env: fixture.env, path: fixture.pathname, kind: "agent" as const };
    expect(recordOpenClawDatabaseQuarantine({ ...quarantine, reason: "original" })).toBe(true);
    fixture.record();
    const before = readPersistedQuarantineRow(fixture.pathname, { env: fixture.env });
    const receipt = readOpenClawAgentIntegrityVerification(fixture.pathname, fixture.env);
    failReceiptWrite(fixture.storePath, "DELETE", "rollback");

    const result =
      operation === "record"
        ? recordOpenClawDatabaseQuarantine({ ...quarantine, reason: "replacement" })
        : clearOpenClawDatabaseQuarantine(fixture.pathname, { env: fixture.env });

    expect(result).toBe(false);
    expect(readPersistedQuarantineRow(fixture.pathname, { env: fixture.env })).toEqual(before);
    expect(readOpenClawAgentIntegrityVerification(fixture.pathname, fixture.env)).toEqual(receipt);
  },
);
