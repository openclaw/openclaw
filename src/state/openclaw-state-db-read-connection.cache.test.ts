import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as executionIdentityContext from "../audit/execution-identity-context.js";
import * as sqlite from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { OpenClawQuarantineReadCleanupError } from "./openclaw-quarantine-error.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  closeRetainedOpenClawStateReadConnections,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import type {
  OpenClawStateReadOnlyDatabase,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

vi.hoisted(() => vi.resetModules());
const worker = vi.hoisted(() => ({
  read: vi.fn<(input: OpenClawStateReadRequest) => OpenClawStateReadReply>(),
  explicitSqliteCloseReleasesNativeResources: true,
  decided: true,
}));
vi.mock("../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/bun-sqlite-library.js")>()),
  getSqliteRuntimeCapabilities: () => ({
    explicitSqliteCloseReleasesNativeResources: worker.explicitSqliteCloseReleasesNativeResources,
    decided: worker.decided,
    reason: "test policy",
  }),
}));
vi.mock("../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-server.js")>()),
  serveOwnedWorkerTasks(handler: (input: OpenClawStateReadRequest) => OpenClawStateReadReply) {
    worker.read.mockImplementation(handler);
  },
}));
import "./openclaw-state-read.worker.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeRetainedOpenClawStateReadConnections();
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  }),
);

beforeEach(() => {
  worker.explicitSqliteCloseReleasesNativeResources = true;
  worker.decided = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

function fixture() {
  const root = tempDirs.make("openclaw-retained-state-reader-");
  const pathname = path.join(root, "state.sqlite");
  const seedDatabase = sqlite.openNodeSqliteDatabase(pathname);
  seedDatabase.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (1)",
  );
  seedDatabase.exec(
    "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER); INSERT INTO config_machine_state VALUES ('nodeHost.config', '1', 1)",
  );
  seedDatabase.close();
  const opens = vi.spyOn(sqlite, "openNodeSqliteDatabase");
  const read = <T>(
    operation: (database: OpenClawStateReadOnlyDatabase) => T,
    location = pathname,
  ) =>
    withOpenClawStateReadOnlyLocation(
      operation,
      pathname,
      location,
      undefined,
      undefined,
      undefined,
      true,
    );
  const value = () => read(({ db }) => db.prepare("SELECT value FROM sample").get()?.value);
  const countOpens = () => opens.mock.calls.filter(([location]) => location === pathname).length;
  const workerRead = (command: OpenClawStateReadRequest["command"]) =>
    worker.read({
      context: {
        environment: { OPENCLAW_STATE_DIR: root },
      },
      databasePath: pathname,
      location: pathname,
      checkFreshAdmission: false,
      command,
    });
  const workerValue = () => {
    const reply = workerRead({ type: "nodeHost.config" });
    if (!reply.ok || reply.type !== "nodeHost.config") {
      throw new Error("Worker read failed");
    }
    return reply.row?.updated_at_ms;
  };
  return { root, pathname, read, value, countOpens, workerValue, workerRead };
}

it("reuses one reader in registered worker commands, refreshes idle, and reopens after eviction", () => {
  const { workerValue: value, countOpens, pathname } = fixture();
  const native = sqlite.requireNodeSqlite();
  const prepare = vi.spyOn(native.DatabaseSync.prototype, "prepare");
  const observation = observeSqliteReadSql(native.StatementSync.prototype);
  const configSelect = /^select "value_json", "updated_at_ms" from "config_machine_state"/iu;
  const contentVersionSelect = /^select "value_json" from "config_machine_state"/iu;
  const dataVersion = /^PRAGMA data_version$/iu;
  expect(value()).toBe(1);
  expect(value()).toBe(1);
  prepare.mockClear();
  observation.queries.length = 0;
  for (let index = 0; index < 10; index++) {
    expect(value()).toBe(1);
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(observation.queries.filter((sql) => configSelect.test(sql))).toHaveLength(10);
  expect(observation.queries.filter((sql) => contentVersionSelect.test(sql))).toHaveLength(10);
  expect(observation.queries.filter((sql) => dataVersion.test(sql))).toHaveLength(20);
  expect(countOpens()).toBe(1);
  const peer = new native.DatabaseSync(pathname);
  try {
    peer.exec("UPDATE config_machine_state SET value_json = '2', updated_at_ms = 2");
    expect(value()).toBe(2);
    expect(prepare.mock.calls.filter(([sql]) => configSelect.test(sql))).toHaveLength(0);
    expect(prepare.mock.calls.filter(([sql]) => dataVersion.test(sql))).toHaveLength(0);
  } finally {
    peer.close();
  }
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(value()).toBe(2);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(countOpens()).toBe(1);
  prepare.mockClear();
  vi.advanceTimersByTime(1);
  expect(value()).toBe(2);
  expect(countOpens()).toBe(2);
  expect(prepare.mock.calls.filter(([sql]) => configSelect.test(sql))).toHaveLength(1);
  expect(prepare.mock.calls.filter(([sql]) => contentVersionSelect.test(sql))).toHaveLength(1);
  expect(prepare.mock.calls.filter(([sql]) => dataVersion.test(sql))).toHaveLength(2);
  observation.restore();
});

it("observes peer commits and closes only the invalidated physical identity", () => {
  const first = fixture();
  const second = fixture();
  expect(first.value()).toBe(1);
  const reader = first.read(({ db }) => db);
  const siblingReader = second.read(({ db }) => db);
  const peer = sqlite.openNodeSqliteDatabase(first.pathname);
  try {
    peer.exec("UPDATE sample SET value = 2");
    expect(first.value()).toBe(2);
    expect(first.read(({ db }) => db)).toBe(reader);
    expect(peer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
  } finally {
    peer.close();
  }
  closeRetainedOpenClawStateReadConnections(readDatabasePathIdentitySync(first.pathname).key);
  expect(reader.isOpen).toBe(false);
  expect(siblingReader.isOpen).toBe(true);
  expect(first.value()).toBe(2);
  expect(first.read(({ db }) => db) === reader).toBe(false);
});

it("evicts failed reads and transaction survivors before the next operation", () => {
  const { read, value } = fixture();
  const reader = read(({ db }) => db);
  expect(() =>
    read(() => {
      throw new Error("query refused");
    }),
  ).toThrow("query refused");
  expect(reader.isOpen).toBe(false);
  const transaction = read(({ db }) => {
    db.exec("BEGIN");
    return db;
  });
  expect(transaction.isOpen).toBe(false);
  expect(value()).toBe(1);
});

it("retries idle reader disposal while other databases remain active", () => {
  const first = fixture();
  const sibling = fixture();
  const reader = first.read(({ db }) => db);
  const siblingReader = sibling.read(({ db }) => db);
  const close = vi.spyOn(reader, "close").mockImplementationOnce(() => {
    throw new Error("synthetic reader close failure");
  });
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(sibling.value()).toBe(1);
  vi.advanceTimersByTime(1);
  expect(reader.isOpen).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 2);
  expect(sibling.value()).toBe(1);
  vi.advanceTimersByTime(2);
  expect(reader.isOpen).toBe(false);
  expect(close).toHaveBeenCalledTimes(2);
  expect(siblingReader.isOpen).toBe(true);
  expect(first.value()).toBe(1);
  expect(first.read(({ db }) => db) === reader).toBe(false);
});

it("keeps missing registry reads noncreating after their cached file disappears", () => {
  const { pathname, read, workerRead } = fixture();
  const reader = read(({ db }) => db);
  fs.rmSync(pathname);
  expect(workerRead({ type: "agentDatabaseRegistry.read" })).toMatchObject({
    ok: true,
    result: { status: "unavailable" },
  });
  expect(reader.isOpen).toBe(false);
  expect(fs.existsSync(pathname)).toBe(false);
});

it("revalidates the schema of a retained reader after a peer changes its version", () => {
  const { pathname, read, value } = fixture();
  const reader = read(({ db }) => db);
  const peer = sqlite.openNodeSqliteDatabase(pathname);
  try {
    peer.exec("PRAGMA user_version = 2147483647");
    expect(() => value()).toThrow(/schema/i);
    expect(reader.isOpen).toBe(false);
    peer.exec("PRAGMA user_version = 0");
    expect(value()).toBe(1);
  } finally {
    peer.close();
  }
});

it("reopens a replacement file and leaves private snapshot readers task-scoped", () => {
  const { root, pathname, read, value } = fixture();
  const previous = read(({ db }) => db);
  const replacementPath = path.join(root, "replacement.sqlite");
  const replacement = sqlite.openNodeSqliteDatabase(replacementPath);
  replacement.exec("CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (7)");
  replacement.close();
  fs.renameSync(pathname, path.join(root, "previous.sqlite"));
  fs.renameSync(replacementPath, pathname);
  expect(value()).toBe(7);
  expect(previous.isOpen).toBe(false);
  const snapshot = path.join(root, "snapshot.sqlite");
  fs.copyFileSync(pathname, snapshot);
  const privateReader = read(({ db }) => db, snapshot);
  expect(privateReader.isOpen).toBe(false);
  fs.rmSync(snapshot);
});

it("reuses admitted audit schema facts and refreshes them after a peer schema change", () => {
  const { pathname, read, workerRead, workerValue } = fixture();
  const reader = read(({ db }) => db);
  const schemaQueries = trackSqliteStatementExecutions(reader, ["schema"], (sql) =>
    /\b(?:sqlite_schema|sqlite_master)\b/iu.test(sql) ? "schema" : null,
  );
  const inspect = vi.spyOn(executionIdentityContext, "inspectExecutionIdentityRunInDatabase");
  const input = { runId: "missing-audit-run", now: 1_000 };
  workerValue();
  expect(schemaQueries.counts.schema).toBe(0);
  expect(inspect).not.toHaveBeenCalled();
  expect(workerRead({ type: "audit.run.inspect", input })).toMatchObject({
    ok: true,
    type: "audit.run.inspect",
    result: { status: "inspected" },
  });
  expect(inspect).toHaveBeenLastCalledWith(reader, input, {
    executionIdentityContexts: false,
    auditEvents: false,
    cronRunReceipts: false,
    executionOwnerLifecycleBindings: false,
  });
  expect(schemaQueries.counts.schema).toBe(0);

  const peer = sqlite.openNodeSqliteDatabase(pathname);
  try {
    for (const table of [
      "execution_identity_contexts",
      "audit_events",
      "cron_run_receipts",
      "execution_owner_lifecycle_bindings",
    ]) {
      peer.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table));
    }
    expect(workerRead({ type: "audit.run.inspect", input })).toMatchObject({
      ok: true,
      type: "audit.run.inspect",
      result: { status: "inspected" },
    });
    expect(inspect).toHaveBeenLastCalledWith(reader, input, {
      executionIdentityContexts: true,
      auditEvents: true,
      cronRunReceipts: true,
      executionOwnerLifecycleBindings: true,
    });
    expect(schemaQueries.counts.schema).toBeGreaterThan(0);
    const refreshedQueries = schemaQueries.counts.schema;
    expect(read(({ db }) => db)).toBe(reader);
    workerValue();
    expect(schemaQueries.counts.schema).toBe(refreshedQueries);
    expect(reader.isTransaction).toBe(false);
  } finally {
    schemaQueries.restore();
    peer.close();
  }
});

it("pins audit schema facts and inspection to one admission snapshot", () => {
  const { pathname, read, workerRead } = fixture();
  const reader = read(({ db }) => db);
  const peer = sqlite.openNodeSqliteDatabase(pathname);
  const original = executionIdentityContext.inspectExecutionIdentityRunInDatabase;
  const inspect = vi
    .spyOn(executionIdentityContext, "inspectExecutionIdentityRunInDatabase")
    .mockImplementationOnce((db, input, schema) => {
      expect(db).toBe(reader);
      expect(db.isTransaction).toBe(true);
      expect(schema.executionIdentityContexts).toBe(false);
      peer.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "execution_identity_contexts"));
      return original(db, input, schema);
    });
  const input = { runId: "admitted-before-first-use", now: 1_000 };
  try {
    expect(workerRead({ type: "audit.run.inspect", input })).toMatchObject({
      ok: true,
      type: "audit.run.inspect",
      result: { status: "inspected" },
    });
    expect(reader.isTransaction).toBe(false);
    expect(workerRead({ type: "audit.run.inspect", input })).toMatchObject({
      ok: true,
      type: "audit.run.inspect",
      result: { status: "inspected" },
    });
    expect(inspect).toHaveBeenLastCalledWith(reader, input, {
      executionIdentityContexts: true,
      auditEvents: false,
      cronRunReceipts: false,
      executionOwnerLifecycleBindings: false,
    });
  } finally {
    peer.close();
  }
});

it("uses a completed capability on the next retained read without hiding real cleanup failures", () => {
  worker.explicitSqliteCloseReleasesNativeResources = false;
  worker.decided = false;
  const { root, pathname, read, workerRead, countOpens } = fixture();
  expect(sqlite.bunSqliteNativeCleanupPending).toBe(true);
  expect(workerRead({ type: "nodeHost.config" }).nativeCleanupFailure).toEqual({
    error: undefined,
  });
  const reader = read(({ db }) => db);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(reader.isOpen).toBe(true);

  worker.explicitSqliteCloseReleasesNativeResources = true;
  worker.decided = true;
  expect(workerRead({ type: "nodeHost.config" }).nativeCleanupFailure).toBeUndefined();
  expect(countOpens()).toBe(1);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(reader.isOpen).toBe(false);
  expect(workerRead({ type: "nodeHost.config" }).nativeCleanupFailure).toBeUndefined();
  expect(countOpens()).toBe(2);
  expect(sqlite.bunSqliteNativeCleanupPending).toBe(true);

  const failure = new Error("native quarantine reader close failed");
  vi.spyOn(
    openClawStateDatabaseCache,
    "assertOpenClawStateDatabaseFreshOpenAllowedAtPath",
  ).mockImplementationOnce((_pathname, _env, reportCleanupFailure) => {
    reportCleanupFailure?.(new OpenClawQuarantineReadCleanupError([failure]));
  });
  const reply = worker.read({
    context: { environment: { OPENCLAW_STATE_DIR: root } },
    databasePath: pathname,
    location: pathname,
    checkFreshAdmission: true,
    command: { type: "nodeHost.config" },
  });
  expect(reply).toMatchObject({ ok: true, row: { updated_at_ms: 1 } });
  expect(reply.nativeCleanupFailure?.error?.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ message: failure.message })]),
  );
});

it.each([false, true])(
  "retains readers and reports native cleanup by capability (capable=%s)",
  (capable) => {
    worker.explicitSqliteCloseReleasesNativeResources = capable;
    const { root, pathname, read, workerRead, countOpens } = fixture();
    if (!capable) {
      expect(sqlite.bunSqliteNativeCleanupPending).toBe(true);
    }
    expect(workerRead({ type: "nodeHost.config" })).toMatchObject({
      ok: true,
      row: { updated_at_ms: 1 },
    });
    const previous = read(({ db }) => db);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(previous.isOpen).toBe(!capable);
    expect(workerRead({ type: "nodeHost.config" })).toMatchObject({
      ok: true,
      row: { updated_at_ms: 1 },
    });
    expect(countOpens()).toBe(capable ? 2 : 1);

    const replacementPath = path.join(root, "replacement.sqlite");
    const replacement = sqlite.openNodeSqliteDatabase(replacementPath);
    replacement.exec(
      "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER); INSERT INTO config_machine_state VALUES ('nodeHost.config', '2', 2)",
    );
    replacement.close();
    fs.renameSync(pathname, path.join(root, "previous.sqlite"));
    fs.renameSync(replacementPath, pathname);
    const reply = workerRead({ type: "nodeHost.config" });
    expect(reply).toMatchObject({
      ok: true,
      row: { updated_at_ms: 2 },
    });
    expect(reply.nativeCleanupFailure).toEqual(capable ? undefined : { error: undefined });
    expect(previous.isOpen).toBe(false);
  },
);
