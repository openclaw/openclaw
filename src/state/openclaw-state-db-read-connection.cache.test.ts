import fs from "node:fs";
import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildAcpDatabaseSessionKey,
  deleteAcpSessionMetaRows,
  upsertAcpSessionMetaRow,
} from "../acp/runtime/session-meta-keys.js";
import * as executionIdentityContext from "../audit/execution-identity-context.js";
import * as sqlite from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { OpenClawQuarantineReadCleanupError } from "./openclaw-quarantine-error.js";
import {
  closeOpenClawStateDatabaseAsync,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeRetainedOpenClawStateReadConnections,
  openOpenClawStateReadOnlyLocation,
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
import { createDanglingSkillWorkshopReviewIndex } from "./openclaw-state-db-corruption.test-support.js";
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
  const workerValue = async () => {
    const reply = await workerRead({ type: "nodeHost.config" });
    if (!reply.ok || reply.type !== "nodeHost.config") {
      throw new Error("Worker read failed");
    }
    return reply.row?.updated_at_ms;
  };
  return { root, pathname, read, value, countOpens, workerValue, workerRead };
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
  return { ...state, peer, key, command, insert };
}

it("retains ACP cohorts across unrelated writes and refreshes committed ACP changes", async () => {
  const { peer, key, command, workerRead, insert } = acpFixture();
  const read = () => workerRead(command);
  const native = sqlite.requireNodeSqlite();
  try {
    expect(await read()).toMatchObject({ ok: true, rows: [null] });
    const observation = observeSqliteReadSql(native.StatementSync.prototype);
    try {
      const check = async (runtimeName: string | null, count: number) => {
        observation.queries.length = 0;
        expect(await read()).toMatchObject({
          ok: true,
          rows: [runtimeName === null ? null : { runtime_session_name: runtimeName }],
        });
        expect(observation.queries).toHaveLength(count);
      };
      await check(null, 0);
      observation.queries.length = 0;
      expect(
        await workerRead({ ...command, entries: [{ keys: [`${key}-missing`] }] }),
      ).toMatchObject({
        ok: true,
        rows: [null],
      });
      expect(observation.queries).toHaveLength(1);
      insert(key, "inserted");
      await check("inserted", 0);
      expect(
        observation.queries.filter((sql) =>
          /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql),
        ),
      ).toHaveLength(0);
      await check("inserted", 0);
      peer.prepare("UPDATE config_machine_state SET updated_at_ms=2").run();
      await check("inserted", 0);
      insert(key, "updated");
      await check("updated", 0);
      await check("updated", 0);
      deleteAcpSessionMetaRows(peer, [key]);
      await check(null, 0);
      await check(null, 0);
    } finally {
      observation.restore();
    }
  } finally {
    peer.close();
  }
});

it("keeps ACP authorizer refusal through batched admission", async () => {
  const { peer, key, command, workerRead, insert, read } = acpFixture();
  try {
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
  } finally {
    peer.close();
  }
});

it("validates a SQL NULL marker on first ACP admission", async () => {
  const { peer, key, command, workerRead, insert } = acpFixture();
  try {
    insert(key, "retained");
    peer
      .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
      .run(CONTENT_VERSION_KEY, null);
    const reply = await workerRead(command);
    expect(reply).toMatchObject({
      ok: false,
      message: expect.stringMatching(/invalid shared state schema content version/iu),
    });
  } finally {
    peer.close();
  }
});

it.each([{ marker: "{", expected: /invalid shared state schema content version/iu }])(
  "preserves first-admission marker refusal before an unavailable ACP payload ($marker)",
  async ({ marker, expected }) => {
    const { peer, command, workerRead } = acpFixture();
    try {
      peer
        .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
        .run(CONTENT_VERSION_KEY, marker);
      peer.exec("DROP TABLE acp_sessions");
      expect(await workerRead(command)).toMatchObject({
        ok: false,
        message: expect.stringMatching(expected),
      });
    } finally {
      peer.close();
    }
  },
);

it("preserves cold schema refusal with a malformed catalog", () => {
  const { pathname, value } = fixture();
  const seed = sqlite.openNodeSqliteDatabase(pathname);
  try {
    seed.exec(
      "CREATE TABLE skill_workshop_collection_reviews (review_id TEXT PRIMARY KEY, create_time INTEGER)",
    );
  } finally {
    seed.close();
  }
  createDanglingSkillWorkshopReviewIndex(pathname);
  expect(value).toThrow(/legacy-workshop-review-index.*openclaw doctor --fix/iu);
});

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

it("reports an unsupported version before an unreadable catalog during open admission", () => {
  const { pathname } = fixture();
  const futureVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
  const writer = sqlite.openNodeSqliteDatabase(pathname);
  try {
    writer.exec(`CREATE INDEX future_index ON sample(value); PRAGMA user_version=${futureVersion}`);
    writer.enableDefensive?.(false);
    writer.exec("PRAGMA writable_schema=ON");
    writer
      .prepare("UPDATE sqlite_schema SET sql=? WHERE name='future_index'")
      .run("CREATE INDEX future_index ON sample(future_column)");
  } finally {
    writer.close();
  }
  const before = fs.readFileSync(pathname);
  expect(() => {
    openOpenClawStateReadOnlyLocation(pathname, pathname).close();
  }).toThrow(`uses newer schema version ${futureVersion}`);
  expect(fs.readFileSync(pathname)).toEqual(before);
});

it("observes peer commits and closes only the invalidated physical identity", () => {
  const first = fixture();
  const second = fixture();
  expect(first.value()).toBe(1);
  const reader = first.read(({ db }) => db);
  const siblingReader = second.read(({ db }) => db);
  const peer = sqlite.openNodeSqliteDatabase(first.pathname);
  const observation = observeSqliteReadSql(sqlite.requireNodeSqlite().StatementSync.prototype);
  try {
    peer.exec("UPDATE sample SET value = 2");
    expect(
      first.read(({ db }) => {
        const select = () =>
          runSqliteReadOperationSync(db, () => db.prepare("SELECT value FROM sample").get()?.value);
        return [select(), select()];
      }),
    ).toEqual([2, 2]);
    expect(
      observation.queries.filter((sql) =>
        /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql),
      ),
    ).toHaveLength(0);
    expect(first.read(({ db }) => db)).toBe(reader);
    expect(peer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
  } finally {
    observation.restore();
    peer.close();
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

it.each(["missing", "replacement"] as const)(
  "retires stale readers after a %s file identity",
  async (kind) => {
    const { root, pathname, read, value, workerRead } = fixture();
    const previous = read(({ db }) => db);
    if (kind === "missing") {
      fs.rmSync(pathname);
      expect(await workerRead({ type: "agentDatabaseRegistry.read" })).toMatchObject({
        ok: true,
        result: { status: "unavailable" },
      });
      expect(fs.existsSync(pathname)).toBe(false);
    } else {
      const replacementPath = path.join(root, "replacement.sqlite");
      const replacement = sqlite.openNodeSqliteDatabase(replacementPath);
      replacement.exec("CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (7)");
      replacement.close();
      fs.renameSync(pathname, path.join(root, "previous.sqlite"));
      fs.renameSync(replacementPath, pathname);
      expect(value()).toBe(7);
      const snapshot = path.join(root, "snapshot.sqlite");
      fs.copyFileSync(pathname, snapshot);
      const privateReader = read(({ db }) => db, snapshot);
      expect(privateReader.isOpen).toBe(false);
      fs.rmSync(snapshot);
    }
    expect(previous.isOpen).toBe(false);
  },
);

it("pins audit schema facts and consumes peer DDL publications made during inspection", async () => {
  const { pathname, read, workerRead, workerValue } = fixture();
  const reader = read(({ db }) => db);
  const peer = sqlite.openNodeSqliteDatabase(pathname);
  const schemaQueries = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(reader),
    ["schema"],
    (sql) => (/\b(?:sqlite_schema|sqlite_master)\b/iu.test(sql) ? "schema" : null),
  );
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
  try {
    await workerValue();
    expect(schemaQueries.counts.schema).toBe(0);
    expect(inspect).not.toHaveBeenCalled();
    await audit();
    expect(reader.isTransaction).toBe(false);
    await audit();
    expect(inspect).toHaveBeenLastCalledWith(reader, input, {
      executionIdentityContexts: true,
      auditEvents: false,
      cronRunReceipts: false,
      executionOwnerLifecycleBindings: false,
    });
    expect(schemaQueries.counts.schema).toBe(0);
    const refreshedQueries = schemaQueries.counts.schema;
    expect(read(({ db }) => db)).toBe(reader);
    await workerValue();
    expect(schemaQueries.counts.schema).toBe(refreshedQueries);
    expect(reader.isTransaction).toBe(false);
  } finally {
    schemaQueries.restore();
    peer.close();
  }
});

it("retains readers, replaces files, and reports cleanup as native close capability completes", async () => {
  worker.explicitSqliteCloseReleasesNativeResources = false;
  worker.decided = false;
  const { root, pathname, read, workerRead, countOpens } = fixture();
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
  const replacementPath = path.join(root, "replacement.sqlite");
  const replacement = sqlite.openNodeSqliteDatabase(replacementPath);
  replacement.exec(
    "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER); INSERT INTO config_machine_state VALUES ('nodeHost.config', '2', 2)",
  );
  replacement.close();
  fs.renameSync(pathname, path.join(root, "previous.sqlite"));
  fs.renameSync(replacementPath, pathname);
  const reply = await workerRead({ type: "nodeHost.config" });
  expect(reply).toMatchObject({ ok: true, row: { updated_at_ms: 2 } });
  expect(reply.nativeCleanupFailure).toBeUndefined();
  expect(previous.isOpen).toBe(false);
  const failure = new Error("native quarantine reader close failed");
  vi.spyOn(
    openClawStateDatabaseCache,
    "assertOpenClawStateDatabaseFreshOpenAllowedAtPath",
  ).mockImplementationOnce((_pathname, _env, reportCleanupFailure) => {
    reportCleanupFailure?.(new OpenClawQuarantineReadCleanupError([failure]));
  });
  const failedCleanup = await worker.read({
    context: { environment: { OPENCLAW_STATE_DIR: root } },
    databasePath: pathname,
    location: pathname,
    checkFreshAdmission: true,
    command: { type: "nodeHost.config" },
  });
  expect(failedCleanup).toMatchObject({ ok: true, row: { updated_at_ms: 2 } });
  expect(failedCleanup.nativeCleanupFailure?.error?.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ message: failure.message })]),
  );
});
