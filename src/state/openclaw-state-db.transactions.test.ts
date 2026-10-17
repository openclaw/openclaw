import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);

function publishForeignSchemaOwner(databasePath: string, incomplete = false): string {
  const marker = resolveGatewayStateOwnerPath(databasePath);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(
    marker,
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
  return marker;
}

it.each(["unchanged schema", "future schema"] as const)(
  "joins a foreign schema owner published between cold open and the first write callback: %s",
  (schema) => {
    const options = {
      path: path.join(tempDirs.make("state-first-write-schema-"), "state.sqlite"),
    };
    const marker = resolveGatewayStateOwnerPath(options.path);
    let opened: EngineConnection | undefined;
    let foreignHeld = false;
    let injected = false;
    const callback = vi.fn(({ db }: { db: EngineConnection }) => {
      expect(foreignHeld).toBe(false);
      db.prepare(
        "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
      ).run("first-write", "committed-once", "{}", 1);
      return "written";
    });
    const unregister = registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (
        injected ||
        event.kind !== "opened" ||
        resolveGatewayStateOwnerPath(event.database.path) !== marker
      ) {
        return;
      }
      injected = true;
      opened = event.database.db;
      publishForeignSchemaOwner(event.database.path);
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
    try {
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
      expect(
        reader.prepare("SELECT event_key FROM diagnostic_events WHERE scope='first-write'").all(),
      ).toEqual(schema === "unchanged schema" ? [{ event_key: "committed-once" }] : []);
    } finally {
      unregister();
      wait.mockRestore();
      fs.rmSync(marker, { force: true });
    }
  },
);

it.each([
  { phase: "cached", publication: "schema" },
  { phase: "entered callback", publication: "schema" },
  { phase: "failed rollback", publication: "incomplete" },
] as const)(
  "does not retry $publication owner refusal after $phase admission",
  ({ phase, publication }) => {
    const options = { path: path.join(tempDirs.make("state-no-write-replay-"), "state.sqlite") };
    const marker = resolveGatewayStateOwnerPath(options.path);
    const existing = phase === "cached" ? openOpenClawStateDatabase(options) : undefined;
    if (existing) {
      publishForeignSchemaOwner(existing.path, publication === "incomplete");
    }
    let restoreRollback: (() => void) | undefined;
    const unregister = registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (
        phase !== "failed rollback" ||
        event.kind !== "opened" ||
        resolveGatewayStateOwnerPath(event.database.path) !== marker
      ) {
        return;
      }
      publishForeignSchemaOwner(event.database.path, publication === "incomplete");
      const exec = event.database.db.exec.bind(event.database.db);
      const rollback = vi.spyOn(event.database.db, "exec").mockImplementation((sql) => {
        if (sql === "ROLLBACK") {
          throw new Error("Synthetic rollback cleanup failure");
        }
        exec(sql);
      });
      restoreRollback = () => rollback.mockRestore();
    });
    const callback = vi.fn(({ db }: { db: EngineConnection }) => {
      db.prepare(
        "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
      ).run("no-replay", "must-roll-back", "{}", 1);
      publishForeignSchemaOwner(options.path, publication === "incomplete");
      assertStateDatabaseAccessAllowed(options.path);
    });
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      throw new Error("Unsafe transaction replay attempted");
    });
    try {
      expect(() => runOpenClawStateWriteTransaction(callback, options)).toThrow();
      expect(callback).toHaveBeenCalledTimes(phase === "entered callback" ? 1 : 0);
      expect(wait).not.toHaveBeenCalled();
      using reader = new DatabaseSync(options.path, { readOnly: true });
      expect(
        reader.prepare("SELECT event_key FROM diagnostic_events WHERE scope='no-replay'").all(),
      ).toEqual([]);
    } finally {
      unregister();
      restoreRollback?.();
      wait.mockRestore();
      fs.rmSync(marker, { force: true });
    }
  },
);

it("refuses a savepoint in an unmanaged enclosing transaction", () => {
  const options = {
    path: path.join(tempDirs.make("state-unmanaged-transaction-"), "state.sqlite"),
  };
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
  const options = { path: path.join(tempDirs.make("state-native-contention-"), "state.sqlite") };
  const database = openOpenClawStateDatabase(options);
  const other = new DatabaseSync(database.path);
  const write = vi.fn(() => {
    database.db
      .prepare(
        "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
      )
      .run("native-transaction", "committed", "{}", 1);
  });
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
    expect(
      other
        .prepare("SELECT event_key FROM diagnostic_events WHERE scope=?")
        .all("native-transaction"),
    ).toEqual([{ event_key: "committed" }]);
  } finally {
    if (other.isTransaction) {
      other.exec("ROLLBACK");
    }
    other.close();
  }
});

it("refuses a single-statement write before its effect when shared-state admission is lost", () => {
  const options = { path: path.join(tempDirs.make("state-single-refused-"), "state.sqlite") };
  const database = openOpenClawStateDatabase(options);
  const marker = publishForeignSchemaOwner(database.path);
  const write = vi.fn(({ db }: { db: EngineConnection }) =>
    db
      .prepare(
        "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
      )
      .run("single-statement", "refused", "{}", 1),
  );
  try {
    expect(() =>
      runOpenClawStateWriteTransaction(write, { ...options, database }, { singleStatement: true }),
    ).toThrow(expect.objectContaining({ name: "StateDatabaseAccessError" }));
    expect(write).not.toHaveBeenCalled();
    expect(database.db.isTransaction).toBe(false);
    expect(
      database.db
        .prepare("SELECT event_key FROM diagnostic_events WHERE scope='single-statement'")
        .all(),
    ).toEqual([]);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

it("publishes a committed single statement without an envelope or replaying a failed observer", () => {
  const options = { path: path.join(tempDirs.make("state-single-publication-"), "state.sqlite") };
  const database = openOpenClawStateDatabase(options);
  using reader = new DatabaseSync(database.path, { readOnly: true });
  const events: string[] = [];
  const exec = vi.spyOn(database.db, "exec");
  const write = vi.fn(({ db }: { db: EngineConnection }) => {
    expect(db.isTransaction).toBe(false);
    expect(
      stageSqliteCommittedPublication(db, {
        installFacts: () => {
          expect(db.isTransaction).toBe(false);
          events.push("facts");
        },
        invalidate: () => events.push("invalidated"),
        notify: () => {
          expect(
            reader
              .prepare("SELECT event_key FROM diagnostic_events WHERE scope='single-statement'")
              .all(),
          ).toEqual([{ event_key: "committed" }]);
          events.push("notified");
        },
      }),
    ).toBe(true);
    deferSqlitePostCommitPublication(db, () => {
      events.push("failed observer");
      throw new Error("synthetic observer failure");
    });
    deferSqlitePostCommitPublication(db, () => events.push("last observer"));
    return db
      .prepare(
        "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
      )
      .run("single-statement", "committed", "{}", 1);
  });
  try {
    const result = runOpenClawStateWriteTransaction(write, options, { singleStatement: true });
    expect(result.changes).toBe(1);
    expect(write).toHaveBeenCalledOnce();
    expect(events).toEqual(["facts", "notified", "failed observer", "last observer"]);
    expect(
      exec.mock.calls.filter(([sql]) =>
        /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql),
      ),
    ).toEqual([]);
  } finally {
    exec.mockRestore();
  }
});

it("keeps a nested single statement and its publication subject to the outer rollback", () => {
  const options = { path: path.join(tempDirs.make("state-single-nested-"), "state.sqlite") };
  const database = openOpenClawStateDatabase(options);
  const published = vi.fn();
  expect(() =>
    runOpenClawStateWriteTransaction(({ db }) => {
      runOpenClawStateWriteTransaction(
        ({ db: nested }) => {
          expect(nested.isTransaction).toBe(true);
          deferSqlitePostCommitPublication(nested, published);
          return nested
            .prepare(
              "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
            )
            .run("single-statement", "rolled-back", "{}", 1);
        },
        { ...options, database },
        { singleStatement: true },
      );
      expect(db.isTransaction).toBe(true);
      expect(published).not.toHaveBeenCalled();
      expect(
        db.prepare("SELECT event_key FROM diagnostic_events WHERE scope='single-statement'").all(),
      ).toEqual([{ event_key: "rolled-back" }]);
      throw new Error("synthetic outer rollback");
    }, options),
  ).toThrow("synthetic outer rollback");
  expect(database.db.isTransaction).toBe(false);
  expect(published).not.toHaveBeenCalled();
  expect(
    database.db
      .prepare("SELECT event_key FROM diagnostic_events WHERE scope='single-statement'")
      .all(),
  ).toEqual([]);
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
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = openOpenClawStateDatabase(options).path;
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
    expect(runWithOpenClawStateBusyTimeout((database) => database.db.isOpen, options, 0)).toBe(
      true,
    );
  } finally {
    writer.exec("ROLLBACK;");
    writer.close();
  }
});

it("configures the busy timeout before a doctor schema repair transaction", () => {
  const stateDir = tempDirs.make("openclaw-state-transactions-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  openOpenClawStateDatabase(options);
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

  expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);

  const timeoutIndex = statements.findIndex((sql) =>
    sql.includes(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}`),
  );
  const transactionIndex = statements.indexOf("BEGIN IMMEDIATE");
  expect(timeoutIndex).toBeGreaterThanOrEqual(0);
  expect(transactionIndex).toBeGreaterThan(timeoutIndex);
});

it("uses savepoints for nested write transaction rollback", () => {
  const stateDir = tempDirs.make("openclaw-state-transactions-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

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
      }, options),
    ).toThrow("rollback nested");
  }, options);

  const database = openOpenClawStateDatabase(options);
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
