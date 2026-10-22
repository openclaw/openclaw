import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { seedDeliveryQueueEntry } from "../infra/delivery-queue-sqlite.test-support.js";
import {
  assertStateDatabaseAccessAllowed,
  resolveGatewayStateOwnerPath,
} from "../infra/gateway-state-owner.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteCommittedPublication,
} from "../infra/sqlite-post-commit.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  openOpenClawStateDatabase,
  registerOpenClawStateDatabaseLifecycleListener,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
  runWithOpenClawStateBusyTimeout,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";

type StateDbTestDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const release of releases.splice(0)) {
      release();
    }
    vi.restoreAllMocks();
    fs.rmSync(resolveGatewayStateOwnerPath(options.path), { force: true });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

let options: { path: string };
let marker: string;
const releases: Array<() => void> = [];
beforeEach(() => {
  options = { path: path.join(tempDirs.make("state-transaction-"), "state.sqlite") };
  marker = resolveGatewayStateOwnerPath(options.path);
});

function insertEvent(db: EngineConnection, key: string, scope = "single-statement") {
  return db
    .prepare(
      "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
    )
    .run(scope, key, "{}", 1);
}

function events(db: EngineConnection, scope = "single-statement") {
  return db.prepare("SELECT event_key FROM diagnostic_events WHERE scope=?").all(scope);
}

function onOpen(callback: (db: EngineConnection) => void) {
  releases.push(
    registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind === "opened" && resolveGatewayStateOwnerPath(event.database.path) === marker) {
        callback(event.database.db);
      }
    }),
  );
}

function publishForeignSchemaOwner(databasePath: string, incomplete = false): string {
  const ownerPath = resolveGatewayStateOwnerPath(databasePath);
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
  fs.writeFileSync(
    ownerPath,
    incomplete
      ? '{"pid":'
      : JSON.stringify({
          pid: process.ppid,
          ownerId: "late-foreign-schema-fixture",
          createdAt: new Date().toISOString(),
          configPath: path.join(path.dirname(databasePath), "openclaw.json"),
          role: "sqlite-maintenance",
          stateOwnerKind: "schema",
        }),
  );
  return ownerPath;
}

it.each(["unchanged schema", "future schema"] as const)(
  "joins a foreign schema owner published between cold open and the first write callback: %s",
  (schema) => {
    let opened: EngineConnection | undefined;
    let foreignHeld = false;
    let injected = false;
    const callback = vi.fn(({ db }: { db: EngineConnection }) => {
      expect(foreignHeld).toBe(false);
      insertEvent(db, "committed-once", "first-write");
      return "written";
    });
    onOpen((db) => {
      if (injected) {
        return;
      }
      injected = true;
      opened = db;
      publishForeignSchemaOwner(options.path);
      foreignHeld = true;
    });
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      expect(foreignHeld).toBe(true);
      expect(callback).not.toHaveBeenCalled();
      expect(opened?.isOpen && opened.isTransaction).toBe(false);
      if (schema === "future schema") {
        using peer = new DatabaseSync(options.path);
        peer.exec("PRAGMA user_version = 999999");
      }
      fs.unlinkSync(marker);
      foreignHeld = false;
      return "ok";
    });
    if (schema === "future schema") {
      expect(() => runOpenClawStateWriteTransaction(callback, options)).toThrow(
        /newer.*schema|schema.*newer/i,
      );
      expect(callback).not.toHaveBeenCalled();
    } else {
      expect(runOpenClawStateWriteTransaction(callback, options)).toBe("written");
      expect(callback).toHaveBeenCalledOnce();
    }
    expect(wait).toHaveBeenCalledOnce();
    using reader = new DatabaseSync(options.path, { readOnly: true });
    expect(events(reader, "first-write")).toEqual(
      schema === "unchanged schema" ? [{ event_key: "committed-once" }] : [],
    );
  },
);

it.each([
  { phase: "cached", publication: "schema" },
  { phase: "entered callback", publication: "schema" },
  { phase: "failed rollback", publication: "incomplete" },
] as const)(
  "does not retry $publication owner refusal after $phase admission",
  ({ phase, publication }) => {
    const existing = phase === "cached" ? openOpenClawStateDatabase(options) : undefined;
    if (existing) {
      publishForeignSchemaOwner(existing.path, publication === "incomplete");
    }
    if (phase === "failed rollback") {
      onOpen((db) => {
        publishForeignSchemaOwner(options.path, publication === "incomplete");
        const exec = db.exec.bind(db);
        vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql === "ROLLBACK") {
            throw new Error("Synthetic rollback cleanup failure");
          }
          exec(sql);
        });
      });
    }
    const callback = vi.fn(({ db }: { db: EngineConnection }) => {
      insertEvent(db, "must-roll-back", "no-replay");
      publishForeignSchemaOwner(options.path, publication === "incomplete");
      assertStateDatabaseAccessAllowed(options.path);
    });
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      throw new Error("Unsafe transaction replay attempted");
    });
    expect(() => runOpenClawStateWriteTransaction(callback, options)).toThrow();
    expect(callback).toHaveBeenCalledTimes(phase === "entered callback" ? 1 : 0);
    expect(wait).not.toHaveBeenCalled();
    using reader = new DatabaseSync(options.path, { readOnly: true });
    expect(events(reader, "no-replay")).toEqual([]);
  },
);

it("refuses a savepoint in an unmanaged enclosing transaction", () => {
  const database = openOpenClawStateDatabase(options);
  const callback = vi.fn();
  database.db.exec("BEGIN IMMEDIATE");
  try {
    expect(() => runOpenClawStateWriteTransaction(callback, { ...options, database })).toThrow(
      /unmanaged.*transaction/i,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(true);
  } finally {
    database.db.exec("ROLLBACK");
  }
});

it("lets SQLite exclude a competing cached writer and resumes after its commit", () => {
  const database = openOpenClawStateDatabase(options);
  const other = new DatabaseSync(database.path);
  const write = vi.fn(() => insertEvent(database.db, "committed", "native-transaction"));
  try {
    other.exec("BEGIN IMMEDIATE");
    expect(() => runOpenClawStateWriteTransaction(write, options, { busyTimeoutMs: 0 })).toThrow(
      /locked|busy/i,
    );
    expect(write).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(false);
    other.exec("COMMIT");
    runOpenClawStateWriteTransaction(write, options, { busyTimeoutMs: 0 });
    expect(write).toHaveBeenCalledOnce();
    expect(events(other, "native-transaction")).toEqual([{ event_key: "committed" }]);
  } finally {
    if (other.isTransaction) {
      other.exec("ROLLBACK");
    }
    other.close();
  }
});

it("refuses a single-statement write before its effect when shared-state admission is lost", () => {
  const database = openOpenClawStateDatabase(options);
  publishForeignSchemaOwner(database.path);
  const write = vi.fn(({ db }: { db: EngineConnection }) => insertEvent(db, "refused"));
  expect(() =>
    runOpenClawStateWriteTransaction(write, { ...options, database }, { singleStatement: true }),
  ).toThrow(expect.objectContaining({ name: "StateDatabaseAccessError" }));
  expect(write).not.toHaveBeenCalled();
  expect(database.db.isTransaction).toBe(false);
  expect(events(database.db)).toEqual([]);
});

it("publishes a committed single statement without an envelope or replaying a failed observer", () => {
  const database = openOpenClawStateDatabase(options);
  using reader = new DatabaseSync(database.path, { readOnly: true });
  const publications: string[] = [];
  const exec = vi.spyOn(database.db, "exec");
  const write = vi.fn(({ db }: { db: EngineConnection }) => {
    expect(db.isTransaction).toBe(false);
    expect(
      stageSqliteCommittedPublication(db, {
        installFacts: () => {
          expect(db.isTransaction).toBe(false);
          publications.push("facts");
        },
        invalidate: () => publications.push("invalidated"),
        notify: () => {
          expect(events(reader)).toEqual([{ event_key: "committed" }]);
          publications.push("notified");
        },
      }),
    ).toBe(true);
    deferSqlitePostCommitPublication(db, () => {
      publications.push("failed observer");
      throw new Error("synthetic observer failure");
    });
    deferSqlitePostCommitPublication(db, () => publications.push("last observer"));
    return insertEvent(db, "committed");
  });
  const result = runOpenClawStateWriteTransaction(write, options, { singleStatement: true });
  expect(result.changes).toBe(1);
  expect(write).toHaveBeenCalledOnce();
  expect(publications).toEqual(["facts", "notified", "failed observer", "last observer"]);
  expect(
    exec.mock.calls.filter(([sql]) => /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)),
  ).toEqual([]);
});

it("keeps a nested single statement and its publication subject to the outer rollback", () => {
  const database = openOpenClawStateDatabase(options);
  const published = vi.fn();
  expect(() =>
    runOpenClawStateWriteTransaction(({ db }) => {
      runOpenClawStateWriteTransaction(
        ({ db: nested }) => {
          expect(nested.isTransaction).toBe(true);
          deferSqlitePostCommitPublication(nested, published);
          return insertEvent(nested, "rolled-back");
        },
        { ...options, database },
        { singleStatement: true },
      );
      expect(db.isTransaction).toBe(true);
      expect(published).not.toHaveBeenCalled();
      expect(events(db)).toEqual([{ event_key: "rolled-back" }]);
      throw new Error("synthetic outer rollback");
    }, options),
  ).toThrow("synthetic outer rollback");
  expect(database.db.isTransaction).toBe(false);
  expect(published).not.toHaveBeenCalled();
  expect(events(database.db)).toEqual([]);
});

it("configures checkpoint lock waits before schema mutation", () => {
  const stateDir = tempDirs.make("openclaw-state-transactions-");

  withOpenClawStateStartupMigrationCheckpointDatabase(
    (db) => {
      expect(readSqliteNumberPragma(db, "busy_timeout")).toBe(OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    },
    { env: { OPENCLAW_STATE_DIR: stateDir } },
  );
});

it("reopens a canonical current schema while another connection holds the writer lock", () => {
  const stateDir = tempDirs.make("openclaw-state-transactions-");
  const stateOptions = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = openOpenClawStateDatabase(stateOptions).path;
  seedDeliveryQueueEntry({
    queueName: "outbound",
    entry: {
      id: "pending-telegram-delivery",
      enqueuedAt: 1,
      retryCount: 0,
    },
    metadata: { channel: "telegram", target: "chat-1" },
    stateDir,
  });
  closeOpenClawStateDatabaseForTest();
  const writer = new DatabaseSync(databasePath);
  writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
  try {
    expect(runWithOpenClawStateBusyTimeout((database) => database.db.isOpen, stateOptions, 0)).toBe(
      true,
    );
  } finally {
    writer.exec("ROLLBACK;");
    writer.close();
  }
});

it("configures the busy timeout before a doctor schema repair transaction", () => {
  const stateDir = tempDirs.make("openclaw-state-transactions-");
  const stateOptions = { env: { OPENCLAW_STATE_DIR: stateDir } };
  openOpenClawStateDatabase(stateOptions);
  closeOpenClawStateDatabaseForTest();

  const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
    | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
    | undefined;
  if (!originalExec) {
    throw new Error("DatabaseSync.exec descriptor is unavailable");
  }
  const statements: string[] = [];
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: import("node:sqlite").DatabaseSync,
    sql: string,
  ) {
    statements.push(sql);
    return originalExec.call(this, sql);
  });

  expect(repairOpenClawStateDatabaseSchema(stateOptions).warnings).toEqual([]);

  const timeoutIndex = statements.findIndex((sql) =>
    sql.includes(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}`),
  );
  const transactionIndex = statements.indexOf("BEGIN IMMEDIATE");
  expect(timeoutIndex).toBeGreaterThanOrEqual(0);
  expect(transactionIndex).toBeGreaterThan(timeoutIndex);
});

it("uses savepoints for nested write transaction rollback", () => {
  const stateDir = tempDirs.make("openclaw-state-transactions-");
  const stateOptions = { env: { OPENCLAW_STATE_DIR: stateDir } };

  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb.insertInto("diagnostic_events").values({
        scope: "transaction-test",
        event_key: "outer",
        payload_json: "{}",
        created_at: 1,
      }),
    );
    expect(() =>
      runOpenClawStateWriteTransaction((inner) => {
        const innerDb = getNodeSqliteKysely<StateDbTestDatabase>(inner.db);
        executeSqliteQuerySync(
          inner.db,
          innerDb.insertInto("diagnostic_events").values({
            scope: "transaction-test",
            event_key: "inner",
            payload_json: "{}",
            created_at: 2,
          }),
        );
        throw new Error("rollback nested");
      }, stateOptions),
    ).toThrow("rollback nested");
  }, stateOptions);

  const database = openOpenClawStateDatabase(stateOptions);
  const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
  expect(
    executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("diagnostic_events")
        .select("event_key")
        .where("scope", "=", "transaction-test")
        .orderBy("event_key"),
    ).rows.map((row) => row.event_key),
  ).toEqual(["outer"]);
});
