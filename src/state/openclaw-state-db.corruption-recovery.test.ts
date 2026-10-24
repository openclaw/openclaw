import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

type StateDbTestDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;

const PROBE_SCOPE = "corruption-recovery-test";
// Incident page: the b-tree leaf replaced page 1's SQLite header (NOTADB).
const CORRUPT_PAGE_HEADER = Uint8Array.from([0x0a, 0x04, 0xc7, 0x00, 0xcb, 0x01, 0xb9, 0x00]);
const tempStateDirs = useAutoCleanupTempDirTracker(afterEach);

function createTempStateDir(): string {
  return fs.realpathSync(tempStateDirs.make("openclaw-state-db-corruption-"));
}

function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), { errcode });
}

function insertProbeEvent(env: NodeJS.ProcessEnv, eventKey: string): void {
  const event = { scope: PROBE_SCOPE, event_key: eventKey, payload_json: "{}", created_at: 1 };
  runOpenClawStateWriteTransaction(
    (database) => {
      executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<StateDbTestDatabase>(database.db)
          .insertInto("diagnostic_events")
          .values(event),
      );
    },
    { env },
  );
}

function readProbeEventKeys(database: { db: EngineConnection }): string[] {
  const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
  const { rows } = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("diagnostic_events")
      .select("event_key")
      .where("scope", "=", PROBE_SCOPE)
      .orderBy("event_key"),
  );
  return rows.map((row) => row.event_key);
}

function prepareCorruptedCachedDatabase(env: NodeJS.ProcessEnv) {
  const poisoned = openOpenClawStateDatabase({ env });
  const databasePath = poisoned.path;
  insertProbeEvent(env, "before-corruption");
  expect(readProbeEventKeys(poisoned)).toEqual(["before-corruption"]);

  // Bump the change counter and checkpoint: force rereading page 1 and a complete snapshot.
  const { DatabaseSync } = requireNodeSqlite();
  {
    using second = new DatabaseSync(databasePath);
    second.exec(
      `INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at)
       VALUES ('${PROBE_SCOPE}', 'second-connection', '{}', 2)`,
    );
    second.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }
  const healthySnapshot = fs.readFileSync(databasePath);
  const page = Buffer.alloc(4096);
  page.set(CORRUPT_PAGE_HEADER, 0);
  const handle = fs.openSync(databasePath, "r+");
  try {
    fs.writeSync(handle, page, 0, page.length, 0);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  // Remove cached WAL page 1 so the corrupt main file is actually read.
  fs.rmSync(`${databasePath}-wal`, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
  return { databasePath, healthySnapshot, poisoned };
}

function expectNotADatabaseError(operation: () => unknown): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).toMatchObject({
    message: expect.stringContaining("file is not a database"),
    code: "ERR_SQLITE_ERROR",
    errcode: 26,
  });
}

afterEach(() => closeOpenClawStateDatabaseForTest());
const cachedAt = (pathname: string) =>
  openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(pathname);

it("preserves the shared WAL when evicting a poisoned cache owner", () => {
  const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
  const cached = openOpenClawStateDatabase({ env });
  insertProbeEvent(env, "committed-before-eviction");
  const walPath = `${cached.path}-wal`;
  const walBytesBeforeEviction = fs.statSync(walPath).size;
  const { DatabaseSync } = requireNodeSqlite();
  using peer = new DatabaseSync(cached.path);
  const close = vi.spyOn(cached.walMaintenance, "close");

  try {
    peer.exec("BEGIN;");
    peer.prepare("SELECT count(*) FROM diagnostic_events").get();
    expect(
      openClawStateDatabaseCache.evictOpenClawStateDatabaseAfterCorruption(
        cached,
        sqliteError("database disk image is malformed", 11),
      ),
    ).toBe(true);

    expect(cachedAt(cached.path)).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({ checkpointMode: "PASSIVE" });
    expect(fs.statSync(walPath).size).toBe(walBytesBeforeEviction);
    expect(peer.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(
      peer.prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?").get(PROBE_SCOPE),
    ).toEqual({ event_key: "committed-before-eviction" });
  } finally {
    peer.exec("ROLLBACK;");
  }
});

it("does not evict a different cached owner when an injected write handle fails", () => {
  const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
  const cached = openOpenClawStateDatabase({ env });
  const { DatabaseSync } = requireNodeSqlite();
  using injectedDb = new DatabaseSync(":memory:");
  const injected = {
    db: injectedDb,
    path: cached.path,
    walMaintenance: {
      stop: async () => {},
      checkpoint: () => false,
      reclaimFreePages: createSqliteWalReclamationResult,
      close: () => false,
    },
  };

  expect(() =>
    runOpenClawStateWriteTransaction(
      () => {
        throw sqliteError("file is not a database", 26);
      },
      { database: injected },
    ),
  ).toThrow(/file is not a database/u);
  expect(cachedAt(cached.path)).toBe(cached);
  expect([cached.db.isOpen, injectedDb.isOpen]).toEqual([true, true]);
});
it.each(["write", "Kysely read", "raw read-only"])("recovers after a corrupt %s", (operation) => {
  const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
  const { databasePath, healthySnapshot, poisoned } = prepareCorruptedCachedDatabase(env);
  expectNotADatabaseError(() => {
    if (operation === "write") {
      return insertProbeEvent(env, "during-corruption");
    }
    if (operation === "Kysely read") {
      return readProbeEventKeys(poisoned);
    }
    return withOpenClawStateDatabaseReadOnly(
      ({ db }) => db.prepare("SELECT count(*) AS total FROM diagnostic_events").get(),
      { env },
    );
  });
  expect(cachedAt(databasePath)).toBeUndefined();
  fs.writeFileSync(databasePath, healthySnapshot);
  const reopened = openOpenClawStateDatabase({ env });
  expect(reopened).not.toBe(poisoned);
  expect(reopened.db.isOpen).toBe(true);
  expect(readProbeEventKeys(reopened)).toEqual(["before-corruption", "second-connection"]);
});
