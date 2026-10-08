import fs from "node:fs";
import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import * as executionIdentityContext from "../audit/execution-identity-context.js";
import * as sqlite from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { OpenClawQuarantineReadCleanupError } from "./openclaw-quarantine-error.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
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
  const peer = new (sqlite.requireNodeSqlite().DatabaseSync)(state.pathname);
  peer.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "acp_sessions", {
      endMarker: "CREATE TABLE IF NOT EXISTS acp_replay_sessions",
      includeEndMarker: false,
    }),
  );
  const key = buildAcpDatabaseSessionKey("agent:main:acp:admission", "main");
  const command = { type: "acpSessions.metadata" as const, entries: [{ keys: [key] }] };
  const insert = (sessionKey: string, runtimeName: string) =>
    peer
      .prepare(
        "INSERT INTO acp_sessions (session_key, backend, agent, runtime_session_name, mode, state, last_activity_at, updated_at) VALUES (?, 'fixture', 'main', ?, 'persistent', 'idle', 1, 1)",
      )
      .run(sessionKey, runtimeName);
  return { ...state, peer, key, command, insert };
}

it("batches ACP rows with revision admission and retains the following warm lookup", async () => {
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
      await check(null, 1);
      observation.queries.length = 0;
      expect(
        await workerRead({ ...command, entries: [{ keys: [`${key}-missing`] }] }),
      ).toMatchObject({
        ok: true,
        rows: [null],
      });
      expect(observation.queries).toHaveLength(2);
      insert(key, "inserted");
      await check("inserted", 2);
      expect(
        observation.queries.filter((sql) =>
          /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(sql),
        ),
      ).toHaveLength(1);
      await check("inserted", 1);
      peer.prepare("UPDATE acp_sessions SET runtime_session_name='updated'").run();
      await check("updated", 2);
      await check("updated", 1);
      peer.prepare("DELETE FROM acp_sessions").run();
      await check(null, 2);
      await check(null, 1);
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
    reader.setAuthorizer((action, table) =>
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

it.each([
  { change: "insertion", before: undefined, after: "1", expected: undefined },
  { change: "update", before: "1", after: "2", expected: undefined },
  { change: "deletion", before: "1", after: undefined, expected: undefined },
  {
    change: "newer",
    before: "1",
    after: String(OPENCLAW_STATE_SCHEMA_VERSION + 1),
    expected: /newer schema version/iu,
  },
  {
    change: "malformed",
    before: "1",
    after: "{",
    expected: /invalid shared state schema content version/iu,
  },
  {
    change: "SQL NULL",
    before: "1",
    after: null,
    expected: /invalid shared state schema content version/iu,
  },
])(
  "validates a foreign $change marker before serving batched ACP metadata",
  async ({ before, after, expected }) => {
    const { peer, key, command, workerRead, insert } = acpFixture();
    const storeMarker = (value: string | null) =>
      peer
        .prepare(
          "INSERT INTO config_machine_state VALUES (?, ?, 1) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json",
        )
        .run(CONTENT_VERSION_KEY, value);
    try {
      insert(key, "retained");
      if (before !== undefined) {
        storeMarker(before);
      }
      expect(await workerRead(command)).toMatchObject({
        ok: true,
        rows: [{ runtime_session_name: "retained" }],
      });
      if (after === undefined) {
        peer.prepare("DELETE FROM config_machine_state WHERE state_key=?").run(CONTENT_VERSION_KEY);
      } else {
        storeMarker(after);
      }
      const reply = await workerRead(command);
      if (expected) {
        expect(reply).toMatchObject({ ok: false, message: expect.stringMatching(expected) });
      } else {
        expect(reply).toMatchObject({ ok: true, rows: [{ runtime_session_name: "retained" }] });
      }
    } finally {
      peer.close();
    }
  },
);

it.each([
  { marker: "1", expected: /no such table.*acp_sessions/iu },
  { marker: String(OPENCLAW_STATE_SCHEMA_VERSION + 1), expected: /newer schema version/iu },
  { marker: "{", expected: /invalid shared state schema content version/iu },
])(
  "preserves marker refusal before an unavailable ACP payload ($marker)",
  async ({ marker, expected }) => {
    const { peer, command, workerRead } = acpFixture();
    try {
      expect(await workerRead(command)).toMatchObject({ ok: true, rows: [null] });
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

it("keeps maximum ACP cohort ordering and handles empty cohorts", async () => {
  const { peer, key, command, workerRead, insert } = acpFixture();
  try {
    const keys = Array.from({ length: 192 }, (_, index) => `${key}-${index}`);
    insert(keys[0]!, "first");
    insert(keys[191]!, "last");
    const reply = await workerRead({
      ...command,
      entries: Array.from({ length: 64 }, (_, index) => ({
        keys: keys.slice(index * 3, index * 3 + 3),
      })),
    });
    expect(reply).toMatchObject({ ok: true, type: "acpSessions.metadata" });
    if (!reply.ok || reply.type !== "acpSessions.metadata") {
      throw new Error("ACP metadata read failed");
    }
    expect(reply.rows).toHaveLength(64);
    expect(reply.rows[0]).toMatchObject({ runtime_session_name: "first" });
    expect(reply.rows[63]).toMatchObject({ runtime_session_name: "last" });
    expect(reply.rows.slice(1, 63)).toEqual(Array(62).fill(null));
    peer.prepare("INSERT INTO config_machine_state VALUES (?, '1', 1)").run(CONTENT_VERSION_KEY);
    expect(await workerRead({ ...command, entries: [] })).toMatchObject({ ok: true, rows: [] });
  } finally {
    peer.close();
  }
});

it("reuses one reader in registered worker commands, refreshes idle, and reopens after eviction", async () => {
  const { workerValue: value, countOpens, pathname } = fixture();
  const native = sqlite.requireNodeSqlite();
  const prepare = vi.spyOn(native.DatabaseSync.prototype, "prepare");
  const observation = observeSqliteReadSql(native.StatementSync.prototype);
  const configSelect = /^select "value_json", "updated_at_ms" from "config_machine_state"/iu;
  const contentVersionSelect = /^select "value_json" from "config_machine_state"/iu;
  const dataVersion = /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu;
  const userVersion = /^PRAGMA user_version$/iu;
  const catalogRead = /\b(?:sqlite_schema|sqlite_master)\b/iu;
  expect(await value()).toBe(1);
  expect.soft(observation.queries.filter((sql) => userVersion.test(sql))).toHaveLength(1);
  expect.soft(observation.queries.filter((sql) => catalogRead.test(sql))).toHaveLength(1);
  expect(await value()).toBe(1);
  // First admission uses its native pragma; the retained observation caches on its second use.
  expect(await value()).toBe(1);
  prepare.mockClear();
  observation.queries.length = 0;
  for (let index = 0; index < 10; index++) {
    expect(await value()).toBe(1);
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(observation.queries.filter((sql) => configSelect.test(sql))).toHaveLength(10);
  expect(observation.queries.filter((sql) => contentVersionSelect.test(sql))).toHaveLength(0);
  expect(observation.queries.filter((sql) => dataVersion.test(sql))).toHaveLength(10);
  expect(countOpens()).toBe(1);
  const peer = new native.DatabaseSync(pathname);
  try {
    peer.exec("UPDATE config_machine_state SET value_json = '2', updated_at_ms = 2");
    expect(await value()).toBe(2);
    expect(observation.queries.filter((sql) => contentVersionSelect.test(sql))).toHaveLength(1);
    expect(await value()).toBe(2);
    expect(observation.queries.filter((sql) => contentVersionSelect.test(sql))).toHaveLength(1);
    expect(prepare.mock.calls.filter(([sql]) => configSelect.test(sql))).toHaveLength(0);
    expect(prepare.mock.calls.filter(([sql]) => dataVersion.test(sql))).toHaveLength(0);
  } finally {
    peer.close();
  }
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(await value()).toBe(2);
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(countOpens()).toBe(1);
  prepare.mockClear();
  vi.advanceTimersByTime(1);
  expect(await value()).toBe(2);
  expect(countOpens()).toBe(2);
  expect(prepare.mock.calls.filter(([sql]) => configSelect.test(sql))).toHaveLength(1);
  expect(prepare.mock.calls.filter(([sql]) => contentVersionSelect.test(sql))).toHaveLength(1);
  expect(prepare.mock.calls.filter(([sql]) => dataVersion.test(sql))).toHaveLength(1);
  observation.restore();
});

it.each([false, true])(
  "preserves cold schema refusal precedence with a malformed catalog (newer header: %s)",
  (newerHeader) => {
    const { pathname, value } = fixture();
    const seed = sqlite.openNodeSqliteDatabase(pathname);
    try {
      seed.exec(
        "CREATE TABLE skill_workshop_collection_reviews (review_id TEXT PRIMARY KEY, create_time INTEGER)",
      );
      if (newerHeader) {
        seed.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      }
    } finally {
      seed.close();
    }
    createDanglingSkillWorkshopReviewIndex(pathname);
    expect(value).toThrow(
      newerHeader
        ? /newer schema version/iu
        : /legacy-workshop-review-index.*openclaw doctor --fix/iu,
    );
  },
);

it.each([
  { change: "insertion", before: undefined, after: "1", expected: 1 },
  { change: "update", before: "1", after: "2", expected: 2 },
  { change: "deletion", before: "1", after: undefined, expected: 0 },
  {
    change: "newer version",
    before: "1",
    after: String(OPENCLAW_STATE_SCHEMA_VERSION + 1),
    expected: /newer schema version/iu,
  },
  {
    change: "malformed version",
    before: "1",
    after: "{",
    expected: /invalid shared state schema content version/iu,
  },
])("observes a foreign content-marker $change after warm reads", ({ before, after, expected }) => {
  const { pathname, read } = fixture();
  const { DatabaseSync } = sqlite.requireNodeSqlite();
  const peer = new DatabaseSync(pathname);
  const insert = peer.prepare(
    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
  );
  const version = () => read(({ db }) => readStateSchemaContentVersion(db));
  try {
    if (before !== undefined) {
      insert.run(CONTENT_VERSION_KEY, before);
    }
    expect(version()).toBe(before === undefined ? 0 : 1);
    expect(version()).toBe(before === undefined ? 0 : 1);
    if (after === undefined) {
      peer.prepare("DELETE FROM config_machine_state WHERE state_key = ?").run(CONTENT_VERSION_KEY);
    } else if (before === undefined) {
      insert.run(CONTENT_VERSION_KEY, after);
    } else {
      peer
        .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
        .run(after, CONTENT_VERSION_KEY);
    }
    if (typeof expected === "number") {
      expect(version()).toBe(expected);
    } else {
      expect(version).toThrow(expected);
    }
  } finally {
    peer.close();
  }
});

it.each(["read", "open"])(
  "reports an unsupported version before an unreadable catalog during %s admission",
  (kind) => {
    const { pathname, read } = fixture();
    const futureVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
    const writer = sqlite.openNodeSqliteDatabase(pathname);
    try {
      writer.exec(
        `CREATE INDEX future_index ON sample(value); PRAGMA user_version=${futureVersion}`,
      );
      writer.enableDefensive?.(false);
      writer.exec("PRAGMA writable_schema=ON");
      writer
        .prepare("UPDATE sqlite_schema SET sql=? WHERE name='future_index'")
        .run("CREATE INDEX future_index ON sample(future_column)");
    } finally {
      writer.close();
    }
    const before = fs.readFileSync(pathname);
    const operation = vi.fn();
    expect(() => {
      if (kind === "open") {
        openOpenClawStateReadOnlyLocation(pathname, pathname).close();
      } else {
        read(operation);
      }
    }).toThrow(`uses newer schema version ${futureVersion}`);
    expect(operation).not.toHaveBeenCalled();
    expect(fs.readFileSync(pathname)).toEqual(before);
  },
);

it("keeps content markers current through local writes, rollback, and authorizers", () => {
  const database = sqlite.openNodeSqliteDatabase(":memory:");
  database.exec(
    "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)",
  );
  database.prepare("INSERT INTO config_machine_state VALUES (?, '1', 1)").run(CONTENT_VERSION_KEY);
  const update = database.prepare(
    "UPDATE config_machine_state SET value_json = ? WHERE state_key = ?",
  );
  admitSqliteSchema(database);
  const version = () =>
    runSqliteReadOperationSync(database, () => readStateSchemaContentVersion(database));
  try {
    expect(version()).toBe(1);
    expect(version()).toBe(1);
    update.run("2", CONTENT_VERSION_KEY);
    expect(version()).toBe(2);
    database.exec("BEGIN");
    update.run("3", CONTENT_VERSION_KEY);
    expect(version()).toBe(3);
    database.exec("ROLLBACK");
    expect(version()).toBe(2);
    database.setAuthorizer((action, table) =>
      action === constants.SQLITE_READ && table === "config_machine_state"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    expect(version).toThrowError(
      expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 23 }),
    );
    database.setAuthorizer(null);
    expect(version()).toBe(2);
  } finally {
    database.close();
  }
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
    ).toHaveLength(1);
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

it.each(["query", "schema", "newer content", "malformed content"] as const)(
  "evicts a reader after %s failure and recovers",
  (kind) => {
    const { pathname, read, value } = fixture();
    const reader = read(({ db }) => db);
    expect(value()).toBe(1);
    if (kind === "query") {
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
    } else {
      const peer = sqlite.openNodeSqliteDatabase(pathname);
      try {
        if (kind === "schema") {
          peer.exec("PRAGMA user_version = 2147483647");
        } else {
          peer
            .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
            .run(
              "state.schema.contentVersion",
              kind === "malformed content" ? "{" : String(OPENCLAW_STATE_SCHEMA_VERSION + 1),
            );
        }
        expect(() => value()).toThrow(
          kind === "malformed content"
            ? /invalid shared state schema content version/i
            : /newer schema version/i,
        );
        expect(reader.isOpen).toBe(false);
        if (kind === "schema") {
          peer.exec("PRAGMA user_version = 0");
        } else {
          peer.exec(
            "DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
          );
        }
        expect(value()).toBe(1);
      } finally {
        peer.close();
      }
    }
  },
);

it("refreshes content markers after local mutation and rollback without retaining a version floor", () => {
  const database = sqlite.openNodeSqliteDatabase(":memory:");
  try {
    database.exec(`
      CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
      INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '4', 1);
    `);
    admitSqliteSchema(database);
    const read = (published?: number) =>
      runSqliteReadOperationSync(database, () =>
        readStateSchemaContentVersion(database, published),
      );
    expect(read()).toBe(4);
    expect(read(7)).toBe(7);
    expect(read()).toBe(4);
    database.exec("BEGIN; UPDATE config_machine_state SET value_json = '5'; SAVEPOINT marker");
    expect(read()).toBe(5);
    database.exec("UPDATE config_machine_state SET value_json = '6'");
    expect(read()).toBe(6);
    database.exec("ROLLBACK TO marker");
    expect(read()).toBe(5);
    database.exec("RELEASE marker; ROLLBACK");
    expect(read()).toBe(4);
    database.exec("DELETE FROM config_machine_state");
    expect(read(7)).toBe(7);
    expect(read()).toBe(0);
  } finally {
    database.close();
  }
});

it.skipIf(typeof sqlite.requireNodeSqlite().DatabaseSync.prototype.setAuthorizer !== "function")(
  "rechecks dynamic authorizer policy before reusing a content marker",
  () => {
    const { read, value } = fixture();
    const reader = read(({ db }) => db);
    expect(value()).toBe(1);
    let allowed = true;
    reader.setAuthorizer((action, table) =>
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

it.each(["between reads", "during inspection"] as const)(
  "pins audit schema facts and refreshes peer changes made %s",
  async (timing) => {
    const { pathname, read, workerRead, workerValue } = fixture();
    const reader = read(({ db }) => db);
    const peer = sqlite.openNodeSqliteDatabase(pathname);
    const schemaQueries = trackSqliteStatementExecutions(reader, ["schema"], (sql) =>
      /\b(?:sqlite_schema|sqlite_master)\b/iu.test(sql) ? "schema" : null,
    );
    const original = executionIdentityContext.inspectExecutionIdentityRunInDatabase;
    const inspect = vi.spyOn(executionIdentityContext, "inspectExecutionIdentityRunInDatabase");
    const during = timing === "during inspection";
    if (during) {
      inspect.mockImplementationOnce((db, input, schema) => {
        expect(db).toBe(reader);
        expect(db.isTransaction).toBe(true);
        expect(schema.executionIdentityContexts).toBe(false);
        peer.exec(
          extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "execution_identity_contexts"),
        );
        return original(db, input, schema);
      });
    }
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
      if (!during) {
        expect(inspect).toHaveBeenLastCalledWith(reader, input, {
          executionIdentityContexts: false,
          auditEvents: false,
          cronRunReceipts: false,
          executionOwnerLifecycleBindings: false,
        });
        expect(schemaQueries.counts.schema).toBe(0);
        for (const table of [
          "execution_identity_contexts",
          "audit_events",
          "cron_run_receipts",
          "execution_owner_lifecycle_bindings",
        ]) {
          peer.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table));
        }
      }
      await audit();
      expect(inspect).toHaveBeenLastCalledWith(reader, input, {
        executionIdentityContexts: true,
        auditEvents: !during,
        cronRunReceipts: !during,
        executionOwnerLifecycleBindings: !during,
      });
      expect(schemaQueries.counts.schema).toBeGreaterThan(0);
      const refreshedQueries = schemaQueries.counts.schema;
      expect(read(({ db }) => db)).toBe(reader);
      await workerValue();
      expect(schemaQueries.counts.schema).toBe(refreshedQueries);
      expect(reader.isTransaction).toBe(false);
    } finally {
      schemaQueries.restore();
      peer.close();
    }
  },
);

it.each([false, true])(
  "retains readers, replaces files, and reports cleanup as native close capability completes=%s",
  async (capable) => {
    worker.explicitSqliteCloseReleasesNativeResources = false;
    worker.decided = !capable;
    const { root, pathname, read, workerRead, countOpens } = fixture();
    expect(sqlite.bunSqliteNativeCleanupPending).toBe(true);
    const first = await workerRead({ type: "nodeHost.config" });
    expect(first).toMatchObject({ ok: true, row: { updated_at_ms: 1 } });
    expect(first.nativeCleanupFailure).toEqual({ error: undefined });
    const previous = read(({ db }) => db);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(previous.isOpen).toBe(true);
    if (capable) {
      worker.explicitSqliteCloseReleasesNativeResources = true;
      worker.decided = true;
      expect((await workerRead({ type: "nodeHost.config" })).nativeCleanupFailure).toBeUndefined();
      expect(countOpens()).toBe(1);
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(previous.isOpen).toBe(false);
    }
    const next = await workerRead({ type: "nodeHost.config" });
    expect(next).toMatchObject({ ok: true, row: { updated_at_ms: 1 } });
    expect(next.nativeCleanupFailure).toEqual(capable ? undefined : { error: undefined });
    expect(countOpens()).toBe(capable ? 2 : 1);
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
    expect(reply.nativeCleanupFailure).toEqual(capable ? undefined : { error: undefined });
    expect(previous.isOpen).toBe(false);
    if (capable) {
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
    }
  },
);
