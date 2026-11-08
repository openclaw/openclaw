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
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  openOpenClawStateDatabase as openDatabase,
  registerOpenClawStateDatabaseLifecycleListener,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction as writeTransaction,
  runWithOpenClawStateBusyTimeout as withBusyTimeout,
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

function expectNotWritten(
  db: EngineConnection,
  write: ReturnType<typeof vi.fn>,
  scope = "single-statement",
) {
  expect(write).not.toHaveBeenCalled();
  expect(db.isTransaction).toBe(false);
  expect(events(db, scope)).toEqual([]);
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
      expect(() => writeTransaction(callback, options)).toThrow(/newer.*schema|schema.*newer/i);
      expect(callback).not.toHaveBeenCalled();
    } else {
      expect(writeTransaction(callback, options)).toBe("written");
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
    const existing = phase === "cached" ? openDatabase(options) : undefined;
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
    expect(() => writeTransaction(callback, options)).toThrow();
    expect(callback).toHaveBeenCalledTimes(phase === "entered callback" ? 1 : 0);
    expect(wait).not.toHaveBeenCalled();
    using reader = new DatabaseSync(options.path, { readOnly: true });
    expect(events(reader, "no-replay")).toEqual([]);
  },
);

it("refuses a savepoint in an unmanaged enclosing transaction", () => {
  const database = openDatabase(options);
  const callback = vi.fn();
  database.db.exec("BEGIN IMMEDIATE");
  try {
    expect(() => writeTransaction(callback, { ...options, database })).toThrow(
      /unmanaged.*transaction/i,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(true);
  } finally {
    database.db.exec("ROLLBACK");
  }
});

it("refuses a single-statement write before its effect when shared-state admission is lost", () => {
  const database = openDatabase(options);
  publishForeignSchemaOwner(database.path);
  const write = vi.fn(({ db }: { db: EngineConnection }) => insertEvent(db, "refused"));
  expect(() =>
    writeTransaction(write, { ...options, database }, { singleStatement: true }),
  ).toThrow(expect.objectContaining({ name: "StateDatabaseAccessError" }));
  expectNotWritten(database.db, write);
});

it("publishes a committed single statement without an envelope", () => {
  const database = openDatabase(options);
  using reader = new DatabaseSync(database.path, { readOnly: true });
  const publications: string[] = [];
  const write = vi.fn(({ db }: { db: EngineConnection }) => {
    expect(db.isTransaction).toBe(false);
    deferSqlitePostCommitPublication(db, () => {
      expect(events(reader)).toEqual([{ event_key: "committed" }]);
      publications.push("notified");
    });
    return insertEvent(db, "committed");
  });
  const result = writeTransaction(write, options, { singleStatement: true });
  expect(result.changes).toBe(1);
  expect(write).toHaveBeenCalledOnce();
  expect(publications).toEqual(["notified"]);
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
  const databasePath = openDatabase(stateOptions).path;
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
  using writer = new DatabaseSync(databasePath);
  writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
  try {
    expect(withBusyTimeout((database) => database.db.isOpen, stateOptions, 0)).toBe(true);
  } finally {
    writer.exec("ROLLBACK;");
  }
});

it("configures the busy timeout before a doctor schema repair transaction", () => {
  const stateDir = tempDirs.make("openclaw-state-transactions-");
  const stateOptions = { env: { OPENCLAW_STATE_DIR: stateDir } };
  openDatabase(stateOptions);
  closeOpenClawStateDatabaseForTest();

  const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
    | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
    | undefined;
  if (!originalExec) {
    throw new Error("DatabaseSync.exec descriptor is unavailable");
  }
  const statements: string[] = [];
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
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

  writeTransaction((database) => {
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
      writeTransaction((inner) => {
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

  const database = openDatabase(stateOptions);
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
