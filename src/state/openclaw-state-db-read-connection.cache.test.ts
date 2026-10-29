import fs from "node:fs";
import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildAcpDatabaseSessionKey,
  deleteAcpSessionMetaRows,
  upsertAcpSessionMetaRow,
} from "../acp/runtime/session-meta-keys.js";
import * as executionIdentityContext from "../audit/execution-identity-context.js";
import * as sqlite from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeRetainedOpenClawStateReadConnections,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import {
  CONTENT_VERSION_KEY,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";
import type {
  OpenClawStateReadOnlyDatabase,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

vi.hoisted(() => vi.resetModules());
const worker = vi.hoisted(() => ({
  read: vi.fn<(input: OpenClawStateReadRequest) => Promise<OpenClawStateReadReply>>(),
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
  serveOwnedWorkerTasks(
    handler: (input: OpenClawStateReadRequest) => Promise<OpenClawStateReadReply>,
  ) {
    worker.read.mockImplementation(handler);
  },
}));
import "./openclaw-state-read.worker.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    closeRetainedOpenClawStateReadConnections();
    await closeOpenClawStateDatabaseAsync();
    openClawStateDatabaseCache.closeOpenClawStateDatabaseForTest();
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
  seed(pathname, 1, true);
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
  const workerRead = (command: OpenClawStateReadRequest["command"], expectedIdentity?: string) =>
    worker.read({
      context: { environment: { OPENCLAW_STATE_DIR: root } },
      databasePath: pathname,
      location: pathname,
      checkFreshAdmission: false,
      expectedIdentity,
      command,
    });
  return { root, pathname, read, value, countOpens, workerRead };
}

function seed(pathname: string, value: number, wal = false) {
  using db = sqlite.openNodeSqliteDatabase(pathname);
  if (wal) {
    db.exec("PRAGMA journal_mode=WAL");
  }
  db.exec("CREATE TABLE sample (value INTEGER)");
  db.prepare("INSERT INTO sample VALUES (?)").run(value);
  db.exec(
    "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)",
  );
  db.prepare("INSERT INTO config_machine_state VALUES ('nodeHost.config', ?, ?)").run(
    String(value),
    value,
  );
}

function acpFixture() {
  const state = fixture();
  const peer = sqlite.openNodeSqliteDatabase(state.pathname);
  peer.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "acp_sessions", {
      endMarker: "CREATE TABLE IF NOT EXISTS acp_replay_sessions",
      includeEndMarker: false,
    }),
  );
  const key = buildAcpDatabaseSessionKey("agent:main:acp:admission", "main");
  const command = { type: "acpSessions.metadata" as const, entries: [{ keys: [key] }] };
  const insert = (sessionKey: string, runtimeName: string) =>
    upsertAcpSessionMetaRow(peer, {
      session_key: sessionKey,
      backend: "fixture",
      agent: "main",
      runtime_session_name: runtimeName,
      mode: "persistent",
      state: "idle",
      last_activity_at: 1,
      updated_at: 1,
    });
  return { ...state, peer, key, command, insert, [Symbol.dispose]: () => peer.close() };
}

it("refreshes committed ACP changes without changing rows after unrelated writes", async () => {
  using state = acpFixture();
  const { peer, key, command, workerRead, insert } = state;
  const read = () => workerRead(command);
  expect(await read()).toMatchObject({ ok: true, rows: [null] });
  const check = async (runtimeName: string | null) => {
    expect(await read()).toMatchObject({
      ok: true,
      rows: [runtimeName === null ? null : { runtime_session_name: runtimeName }],
    });
  };
  insert(key, "inserted");
  await check("inserted");
  peer.prepare("UPDATE config_machine_state SET updated_at_ms=2").run();
  await check("inserted");
  insert(key, "updated");
  await check("updated");
  deleteAcpSessionMetaRows(peer, [key]);
  await check(null);
});

it("keeps ACP authorizer refusal through batched admission", async () => {
  using state = acpFixture();
  const { key, command, workerRead, insert, read } = state;
  insert(key, "private");
  expect(await workerRead(command)).toMatchObject({ ok: true });
  const reader = read(({ db }) => db);
  requireNativeSqliteDatabase(reader).setAuthorizer((action, table) =>
    action === constants.SQLITE_READ && table === "acp_sessions"
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  expect(await workerRead(command)).toMatchObject({
    ok: false,
    message: expect.stringMatching(/prohibited|not authorized/iu),
  });
});

it.each([null, "{"])(
  "rejects invalid first-admission marker %s before reading ACP payloads",
  async (marker) => {
    using state = acpFixture();
    const { peer, key, command, workerRead, insert } = state;
    if (marker === null) {
      insert(key, "retained");
    } else {
      peer.exec("DROP TABLE acp_sessions");
    }
    peer
      .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
      .run(CONTENT_VERSION_KEY, marker);
    expect(await workerRead(command)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/invalid shared state schema content version/iu),
    });
  },
);

it("rejects a replacement content marker with a newer version after warm reads", () => {
  const { pathname, read } = fixture();
  const { DatabaseSync } = sqlite.requireNodeSqlite();
  {
    using peer = new DatabaseSync(pathname);
    peer.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)").run(CONTENT_VERSION_KEY, "1");
  }
  const version = () => read(({ db }) => readStateSchemaContentVersion(db));
  expect(version()).toBe(1);
  expect(version()).toBe(1);
  closeRetainedOpenClawStateReadConnections();
  const replacement = `${pathname}.replacement`;
  fs.copyFileSync(pathname, replacement);
  {
    using peer = new DatabaseSync(replacement);
    peer
      .prepare(
        "INSERT INTO config_machine_state VALUES (?, ?, 1) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json",
      )
      .run(CONTENT_VERSION_KEY, String(OPENCLAW_STATE_SCHEMA_VERSION + 1));
  }
  fs.renameSync(replacement, pathname);
  expect(version).toThrow(/newer schema version/iu);
});

it("observes peer commits and closes only the invalidated physical identity", () => {
  const first = fixture();
  const second = fixture();
  expect(first.value()).toBe(1);
  const reader = first.read(({ db }) => db);
  const siblingReader = second.read(({ db }) => db);
  {
    using peer = sqlite.openNodeSqliteDatabase(first.pathname);
    peer.exec("UPDATE sample SET value = 2");
    expect(first.value()).toBe(2);
    expect(first.read(({ db }) => db)).toBe(reader);
    expect(peer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
  }
  closeRetainedOpenClawStateReadConnections(readDatabasePathIdentitySync(first.pathname).key);
  expect(reader.isOpen).toBe(false);
  expect(siblingReader.isOpen).toBe(true);
  expect(first.value()).toBe(2);
  expect(first.read(({ db }) => db) === reader).toBe(false);
});

it.skipIf(typeof sqlite.requireNodeSqlite().DatabaseSync.prototype.setAuthorizer !== "function")(
  "rechecks dynamic authorizer policy before reusing a content marker",
  () => {
    const { read, value } = fixture();
    const reader = read(({ db }) => db);
    expect(value()).toBe(1);
    let allowed = true;
    requireNativeSqliteDatabase(reader).setAuthorizer((action, table) =>
      !allowed && action === constants.SQLITE_READ && table === "config_machine_state"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    expect(value()).toBe(1);
    allowed = false;
    expect(value).toThrow(/not authorized|prohibited|access to/i);
    expect(reader.isOpen).toBe(false);
    expect(value()).toBe(1);
  },
);

it("reuses one idle timer and expires the reader after its last completed read", () => {
  const { read, value } = fixture();
  const timers = vi.spyOn(globalThis, "setTimeout");
  const reader = read(({ db }) => db);
  for (let index = 0; index < 3; index++) {
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(value()).toBe(1);
    expect(reader.isOpen).toBe(true);
  }
  expect(timers.mock.calls.filter(([, delay]) => delay === SQLITE_IDLE_HANDLE_TTL_MS)).toHaveLength(
    1,
  );
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(reader.isOpen).toBe(true);
  vi.advanceTimersByTime(1);
  expect(reader.isOpen).toBe(false);
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

it("retires stale readers after a missing file identity", async () => {
  const { pathname, read, workerRead } = fixture();
  const previous = read(({ db }) => db);
  fs.rmSync(pathname);
  expect(await workerRead({ type: "agentDatabaseRegistry.read" })).toMatchObject({
    ok: true,
    result: { status: "unavailable" },
  });
  expect(fs.existsSync(pathname)).toBe(false);
  expect(previous.isOpen).toBe(false);
});

it("pins audit schema facts and consumes peer DDL publications made during inspection", async () => {
  const { pathname, read, workerRead } = fixture();
  const reader = read(({ db }) => db);
  using peer = sqlite.openNodeSqliteDatabase(pathname);
  const original = executionIdentityContext.inspectExecutionIdentityRunInDatabase;
  const inspect = vi.spyOn(executionIdentityContext, "inspectExecutionIdentityRunInDatabase");
  inspect.mockImplementationOnce((db, input, schema) => {
    expect(db).toBe(reader);
    expect(db.isTransaction).toBe(true);
    expect(schema.executionIdentityContexts).toBe(false);
    peer.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "execution_identity_contexts"));
    return original(db, input, schema);
  });
  const input = { runId: "missing-audit-run", now: 1_000 };
  const audit = async () =>
    expect(await workerRead({ type: "audit.run.inspect", input })).toMatchObject({
      ok: true,
      type: "audit.run.inspect",
      result: { status: "inspected" },
    });
  expect(await workerRead({ type: "nodeHost.config" })).toMatchObject({
    ok: true,
    type: "nodeHost.config",
  });
  expect(inspect).not.toHaveBeenCalled();
  await audit();
  expect(reader.isTransaction).toBe(false);
  await audit();
  expect(inspect.mock.lastCall?.[2].executionIdentityContexts).toBe(true);
  expect(read(({ db }) => db)).toBe(reader);
  expect(await workerRead({ type: "nodeHost.config" })).toMatchObject({
    ok: true,
    type: "nodeHost.config",
  });
  expect(reader.isTransaction).toBe(false);
});

it("retains readers until native close capability completes", async () => {
  worker.explicitSqliteCloseReleasesNativeResources = false;
  worker.decided = false;
  const { read, workerRead, countOpens } = fixture();
  expect(sqlite.bunSqliteNativeCleanupPending).toBe(true);
  const first = await workerRead({ type: "nodeHost.config" });
  expect(first).toMatchObject({ ok: true, row: { updated_at_ms: 1 } });
  expect(first.nativeCleanupFailure).toEqual({ error: undefined });
  const previous = read(({ db }) => db);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(previous.isOpen).toBe(true);
  worker.explicitSqliteCloseReleasesNativeResources = true;
  worker.decided = true;
  expect((await workerRead({ type: "nodeHost.config" })).nativeCleanupFailure).toBeUndefined();
  expect(countOpens()).toBe(1);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(previous.isOpen).toBe(false);
  const next = await workerRead({ type: "nodeHost.config" });
  expect(next).toMatchObject({ ok: true, row: { updated_at_ms: 1 } });
  expect(next.nativeCleanupFailure).toBeUndefined();
  expect(countOpens()).toBe(2);
  expect(sqlite.bunSqliteNativeCleanupPending).toBe(true);
});

it("refuses replacement during worker preparation, then reopens it and keeps private snapshots task-scoped", async () => {
  const { root, pathname, read, value, workerRead } = fixture();
  const previous = read(({ db }) => db);
  const expectedIdentity = readDatabasePathIdentitySync(pathname).key;
  const replacement = path.join(root, "replacement.sqlite");
  seed(replacement, 7);
  const preparing = createDeferredCore();
  const releasePreparation = createDeferredCore();
  vi.doMock("./config-machine-state.read.worker.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./config-machine-state.read.worker.js")>();
    preparing.resolve();
    await releasePreparation.promise;
    return actual;
  });
  const pending = workerRead(
    { type: "machineState.read", input: { key: "nodeHost.config" } },
    expectedIdentity,
  );
  try {
    await Promise.race([
      preparing.promise,
      pending.then(() => {
        throw new Error("Worker read settled before controlled preparation");
      }),
    ]);
    fs.renameSync(pathname, path.join(root, "previous.sqlite"));
    fs.renameSync(replacement, pathname);
    releasePreparation.resolve();
    const reply = await pending;
    expect(reply).toMatchObject({
      ok: false,
      message: expect.stringMatching(/identity|changed/i),
    });
    expect(reply).not.toHaveProperty("sourceAdmitted", true);
  } finally {
    releasePreparation.resolve();
    try {
      await pending;
    } finally {
      vi.doUnmock("./config-machine-state.read.worker.js");
    }
  }
  expect(value()).toBe(7);
  expect(previous.isOpen).toBe(false);
  const snapshot = path.join(root, "snapshot.sqlite");
  fs.copyFileSync(pathname, snapshot);
  const privateReader = read(({ db }) => db, snapshot);
  expect(privateReader.isOpen).toBe(false);
  fs.rmSync(snapshot);
});
