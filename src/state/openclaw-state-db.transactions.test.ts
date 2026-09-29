import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertStateDatabaseAccessAllowed,
  resolveGatewayStateOwnerPath,
} from "../infra/gateway-state-owner.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  registerOpenClawStateDatabaseLifecycleListener,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
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
    let opened: DatabaseSync | undefined;
    let foreignHeld = false;
    let injected = false;
    const callback = vi.fn(({ db }: { db: DatabaseSync }) => {
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

it.each(
  (["cached", "supplied", "entered callback", "failed rollback"] as const).flatMap((phase) =>
    (["schema", "incomplete"] as const).map((publication) => ({ phase, publication })),
  ),
)("does not retry $publication owner refusal after $phase admission", ({ phase, publication }) => {
  const options = { path: path.join(tempDirs.make("state-no-write-replay-"), "state.sqlite") };
  const marker = resolveGatewayStateOwnerPath(options.path);
  const existing =
    phase === "cached" || phase === "supplied" ? openOpenClawStateDatabase(options) : undefined;
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
  const callback = vi.fn(({ db }: { db: DatabaseSync }) => {
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
    expect(() =>
      runOpenClawStateWriteTransaction(
        callback,
        phase === "supplied" ? { ...options, database: existing } : options,
      ),
    ).toThrow();
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
});

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

it.each(["cached", "supplied"] as const)(
  "lets SQLite exclude a competing %s writer and resumes after its commit",
  (handle) => {
    const options = { path: path.join(tempDirs.make("state-native-contention-"), "state.sqlite") };
    const database = openOpenClawStateDatabase(options);
    const writeOptions = handle === "supplied" ? { ...options, database } : options;
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
      expect(() =>
        runOpenClawStateWriteTransaction(write, writeOptions, { busyTimeoutMs: 0 }),
      ).toThrow(/locked|busy/i);
      expect(write).not.toHaveBeenCalled();
      expect(database.db.isTransaction).toBe(false);
      other.exec("COMMIT");
      runOpenClawStateWriteTransaction(write, writeOptions, { busyTimeoutMs: 0 });
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
  },
);
