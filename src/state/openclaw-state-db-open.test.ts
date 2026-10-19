import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as kyselyCache from "../infra/kysely-sync-cache-state.js";
import * as kyselySync from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as busyTimeout from "../infra/sqlite-busy-timeout.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import { setConsoleSubsystemFilter } from "../logging/console.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNativeSqliteDatabase as nativeDatabase } from "../test-utils/native-sqlite.js";
import {
  openClawStateDatabaseCache as cache,
  recordOpenClawStateDatabaseOpenFailure as recordFailure,
} from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { expectRow, expectRows } from "./openclaw-state-db-fixtures.test-support.js";
import { closeTrackedStateDatabase as closeTracked } from "./openclaw-state-db-handle.js";
import * as initialization from "./openclaw-state-db-initialization.js";
import { openUnpublishedStateDatabase as openDatabase } from "./openclaw-state-db-open.js";
import * as permissions from "./openclaw-state-db-permissions.js";

type Acquisition = ReturnType<typeof openDatabase>;
type AcquisitionParams = Parameters<typeof openDatabase>[0];
const acquiredDatabases = new Set<Acquisition>();
const openNativeDatabase = nodeSqlite.openNodeSqliteDatabase;

function throwing(error: Error) {
  return () => {
    throw error;
  };
}

function acquire(params: AcquisitionParams) {
  const database = openDatabase(params);
  acquiredDatabases.add(database);
  return database;
}

function expectPayload(pathname: string, value = "committed") {
  using database = openNativeDatabase(pathname, { readOnly: true });
  expectRows(database, "SELECT value FROM payload", [{ value }]);
}

function closeAcquisition(database: Acquisition) {
  database.walMaintenance.close();
  closeTracked(nativeDatabase(database.db));
}

function expectReleased(db: DatabaseSync, ownerCount: () => number, isOpen = false) {
  expect(db.isOpen).toBe(isOpen);
  expect(kyselyCache.kyselyByDatabase.has(db)).toBe(false);
  expect(ownerCount()).toBe(0);
}

function expectAggregate(caught: unknown, cause: Error, errors: Error[]) {
  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught).toMatchObject({ cause, errors });
}

function attemptAcquisition(params: AcquisitionParams) {
  let acquired: Acquisition | undefined;
  try {
    acquired = acquire(params);
  } catch (error) {
    return error;
  } finally {
    if (acquired) {
      closeAcquisition(acquired);
    }
  }
  return undefined;
}

async function withCheckpointLogging(
  run: (warn: ReturnType<typeof vi.fn<(line: string) => void>>) => Promise<void>,
) {
  await withEnvAsync({ OPENCLAW_LOG_LEVEL: undefined }, async () => {
    const previousLogging = { ...loggingState };
    const warn = vi.fn<(line: string) => void>();
    try {
      setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
      setConsoleSubsystemFilter(["state/db"]);
      loggingState.forceConsoleToStderr = false;
      loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
      await run(warn);
    } finally {
      Object.assign(loggingState, previousLogging);
    }
  });
}

const databases = new Set<DatabaseSync>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    cache.closeOpenClawStateDatabaseForTest();
    for (const database of acquiredDatabases) {
      if (database.db.isOpen) {
        closeAcquisition(database);
      }
    }
    acquiredDatabases.clear();
    for (const db of databases) {
      closeTracked(db);
    }
    databases.clear();
    vi.runOnlyPendingTimers();
    vi.clearAllTimers();
    vi.useRealTimers();
    cleanup();
  });
});

function observeMaintenanceOwners() {
  const scopes = vi.spyOn(GatewayScheduler.prototype, "scope");
  return () =>
    scopes.mock.results.filter((result) => result.type === "return" && !result.value.signal.aborted)
      .length;
}

function acquisitionFixture() {
  vi.useFakeTimers();
  const maintenanceOwnerCount = observeMaintenanceOwners();
  const pathname = path.join(tempDirs.make("openclaw-state-acquisition-"), "state.sqlite");
  const params = {
    pathname,
    env: {},
    busyTimeoutMs: 50,
    lockFailureReporting: "report" as const,
    ensureSchema: (db: DatabaseSync) => {
      db.exec("CREATE TABLE IF NOT EXISTS payload (value TEXT);");
      const query = kyselySync.getNodeSqliteKysely<{ payload: { value: string } }>(db);
      kyselySync.executeSqliteQuerySync(db, query.selectFrom("payload").selectAll());
    },
    recordOpenFailure: vi.fn(),
  };
  const seed = acquire(params);
  seed.db.exec("INSERT INTO payload VALUES ('committed');");
  closeAcquisition(seed);
  const opened: DatabaseSync[] = [];
  const targetLocations = new Set([pathname, nodeSqlite.resolveExistingSqliteFileUri(pathname)]);
  const openNative = nodeSqlite.openNodeSqliteDatabase;
  const openTracked: typeof openNative = (...args) => {
    const db = openNative(...args);
    databases.add(db);
    if (targetLocations.has(args[0])) {
      opened.push(db);
    }
    return db;
  };
  const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation(openTracked);
  return { params, open, openNative, openTracked, opened, maintenanceOwnerCount, targetLocations };
}

async function expectSuccessfulReopen(params: Parameters<typeof acquire>[0]) {
  const maintenanceOwnerCount = observeMaintenanceOwners();
  const reopened = acquire(params);
  const prepare = vi.spyOn(reopened.db, "prepare");
  const exec = vi.spyOn(reopened.db, "exec");
  try {
    expectRows(reopened.db, "SELECT value FROM payload", [{ value: "committed" }]);
    expect(reopened.db.isOpen).toBe(true);
    expect(maintenanceOwnerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(prepare).toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
  } finally {
    closeAcquisition(reopened);
  }
  expect(maintenanceOwnerCount()).toBe(0);
  prepare.mockClear();
  exec.mockClear();
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
  expect(prepare).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
}

it.each(["initialization", "native open"] as const)(
  "refuses to recreate an existing database removed before %s",
  (boundary) => {
    const { params, open, openTracked } = acquisitionFixture();
    const preservedPath = `${params.pathname}.preserved`;
    const sidecarPath = `${params.pathname}-wal`;
    const sidecarBytes = Buffer.alloc(64, 0x5a);
    const removeDatabase = () => {
      fs.renameSync(params.pathname, preservedPath);
      fs.writeFileSync(sidecarPath, sidecarBytes);
    };
    if (boundary === "initialization") {
      const prepare = initialization.prepareStateDatabaseInitialization;
      vi.spyOn(initialization, "prepareStateDatabaseInitialization").mockImplementationOnce(
        (...args) => {
          removeDatabase();
          return prepare(...args);
        },
      );
    } else {
      open.mockImplementationOnce((...args) => {
        removeDatabase();
        return openTracked(...args);
      });
    }

    expect.soft(attemptAcquisition(params)).toBeInstanceOf(Error);
    expect.soft(fs.existsSync(params.pathname)).toBe(false);
    expect.soft(fs.existsSync(sidecarPath)).toBe(true);
    if (fs.existsSync(sidecarPath)) {
      expect.soft(fs.readFileSync(sidecarPath)).toEqual(sidecarBytes);
    }
    expect
      .soft(
        fs.readdirSync(path.dirname(params.pathname)).filter((name) => name.includes(".orphaned-")),
      )
      .toEqual([]);
    expectPayload(preservedPath);
  },
);

it("refuses a replacement generation before running schema setup", () => {
  const { params, open, openNative, openTracked } = acquisitionFixture();
  const preservedPath = `${params.pathname}.preserved`;
  const ensureSchema = vi.fn(params.ensureSchema);
  params.ensureSchema = ensureSchema;
  open.mockImplementationOnce((...args) => {
    fs.renameSync(params.pathname, preservedPath);
    const replacement = openNative(params.pathname);
    replacement.exec(
      "CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('replacement');",
    );
    replacement.close();
    return openTracked(...args);
  });
  expect.soft(attemptAcquisition(params)).toBeInstanceOf(Error);
  expect.soft(ensureSchema).not.toHaveBeenCalled();
  expectPayload(preservedPath);
  expectPayload(params.pathname, "replacement");
});

it.each([false, true])(
  "preserves file identity across schema writes (existing: %s)",
  (existingSchema) => {
    const { params } = acquisitionFixture();
    const stat = fs.statSync;
    let ctimeAdvanceNs = 0n;
    vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      const result = stat(...args);
      if (
        (process.platform === "linux" || process.platform === "android") &&
        result &&
        args[0] === params.pathname &&
        "ctimeNs" in result
      ) {
        const ctimeNs = result.ctimeNs + ctimeAdvanceNs;
        Object.defineProperties(result, {
          ctimeNs: { value: ctimeNs },
          birthtimeNs: { value: ctimeNs },
        });
      }
      return result;
    });
    syncBuiltinESMExports();
    const before = fs.statSync(params.pathname, { bigint: true });
    const acquired = acquire({
      ...params,
      existingSchema,
      ensureSchema(db) {
        db.exec("CREATE INDEX idx_payload ON payload(value)");
        // Model coarse-clock old Linux hosts without depending on a timer tick.
        ctimeAdvanceNs += 1n;
      },
    });
    const after = fs.statSync(params.pathname, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    if (process.platform === "linux" || process.platform === "android") {
      expect(after.birthtimeNs).not.toBe(before.birthtimeNs);
    }
    expectRows(acquired.db, "PRAGMA index_info(idx_payload)", [
      { seqno: 0, cid: 0, name: "value" },
    ]);
    expectRows(acquired.db, "SELECT value FROM payload", [{ value: "committed" }]);
  },
);

it("does not recreate a removed parent during existing database hardening", () => {
  const { params } = acquisitionFixture();
  const directory = path.dirname(params.pathname);
  const preservedDirectory = path.join(tempDirs.make("openclaw-state-preserved-"), "state");
  const harden = permissions.ensureOpenClawStatePermissions;
  vi.spyOn(permissions, "ensureOpenClawStatePermissions").mockImplementationOnce((...args) => {
    fs.renameSync(directory, preservedDirectory);
    return harden(...args);
  });
  // Refusal must not recreate any path, regardless of the SQLite cleanup diagnostic.
  attemptAcquisition(params);
  expect.soft(fs.existsSync(directory)).toBe(false);
  expectPayload(path.join(preservedDirectory, path.basename(params.pathname)));
});

it("records and reports SQLite errors from scheduled shared-state checkpoints", async () => {
  await withCheckpointLogging(async (warn) => {
    const { params, open } = acquisitionFixture();
    const database = acquire(params);
    open.mockClear();
    const sqlite = nativeDatabase(database.db);
    const prepare = sqlite.prepare.bind(sqlite);
    const checkpointFailure = new Error("checkpoint storage unavailable");
    const intercepted = vi.spyOn(sqlite, "prepare").mockImplementation((sql) => {
      if (sql === "PRAGMA wal_checkpoint(PASSIVE);") {
        throw checkpointFailure;
      }
      return prepare(sql);
    });
    warn.mockClear();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(database.walMaintenance.health).toMatchObject({
      state: "error",
      error: "checkpoint storage unavailable",
      warning: true,
    });
    expect(warn.mock.calls.map(([line]) => JSON.parse(line) as unknown)).toContainEqual(
      expect.objectContaining({
        level: "warn",
        subsystem: "state/db",
        message: "Shared-state WAL maintenance failed",
        error: "checkpoint storage unavailable",
        path: params.pathname,
        checkpoint: database.walMaintenance.health,
      }),
    );
    intercepted.mockRestore();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(database.walMaintenance.health).toMatchObject({ state: "complete", warning: false });
    expect(open).not.toHaveBeenCalled();
  });
});

it.each([
  { kind: "Doctor maintenance", owner: { role: "sqlite-maintenance" } },
  { kind: "schema maintenance", owner: { role: "sqlite-maintenance", stateOwnerKind: "schema" } },
])("defers checkpoints for a foreign $kind owner", async ({ owner }) => {
  await withCheckpointLogging(async (warn) => {
    const { params } = acquisitionFixture();
    const database = acquire(params);
    const seed = acquireGatewayStateOwner({ databasePath: params.pathname });
    const ownerPath = seed.path;
    seed.release();
    fs.writeFileSync(
      ownerPath,
      JSON.stringify({
        pid: process.ppid,
        createdAt: new Date().toISOString(),
        configPath: path.join(path.dirname(params.pathname), "openclaw.json"),
        ...owner,
      }),
    );
    const prepare = vi.spyOn(database.db, "prepare");
    try {
      warn.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(prepare).not.toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
      expect(database.walMaintenance.health).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      fs.rmSync(ownerPath);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(prepare).toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
      expect(database.walMaintenance.health).toMatchObject({ state: "complete" });
    } finally {
      fs.rmSync(ownerPath, { force: true });
      closeAcquisition(database);
    }
  });
});

it.each(["statement cache", "busy timeout finalization", "schema", "hardening"])(
  "releases failed %s setup without losing committed rows",
  async (phase) => {
    const { params, opened, maintenanceOwnerCount } = acquisitionFixture();
    const failure = new Error(`${phase} failed`);
    if (phase === "statement cache") {
      vi.spyOn(kyselySync, "enableNodeSqliteKyselyStatementCache").mockImplementation(
        throwing(failure),
      );
    } else if (phase === "busy timeout finalization") {
      const run = busyTimeout.runWithSqliteBusyTimeout;
      vi.spyOn(busyTimeout, "runWithSqliteBusyTimeout").mockImplementation((...args) => {
        run(...args);
        throw failure;
      });
    } else if (phase === "hardening") {
      const harden = permissions.ensureOpenClawStatePermissions;
      let calls = 0;
      vi.spyOn(permissions, "ensureOpenClawStatePermissions").mockImplementation((...args) => {
        harden(...args);
        if (++calls % 2 === 0) {
          throw failure;
        }
      });
    } else if (phase === "schema") {
      const ensureSchema = params.ensureSchema;
      params.ensureSchema = (db) => {
        ensureSchema(db);
        throw failure;
      };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => acquire(params)).toThrow(failure);
      const db = expectDefined(opened.at(-1), "failed acquisition");
      expectReleased(db, maintenanceOwnerCount);
    }
    expect(params.recordOpenFailure).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    await expectSuccessfulReopen({
      ...params,
      ensureSchema: (db) => {
        expectRow(db, "SELECT value FROM payload", { value: "committed" });
      },
    });
  },
);

it.each(["maintenance", "native", "both"])(
  "retains schema and %s cleanup errors with a disposal-only owner",
  async (cleanupFailure) => {
    const { params, opened, maintenanceOwnerCount } = acquisitionFixture();
    const failure = new Error("schema failed");
    const maintenanceFailure = new Error("maintenance close failed");
    const nativeFailure = new Error("native close failed");
    const configure = sqliteWal.configureSqliteConnectionPragmas;
    const maintenanceFails = cleanupFailure !== "native";
    const nativeFails = cleanupFailure !== "maintenance";
    vi.spyOn(sqliteWal, "configureSqliteConnectionPragmas").mockImplementation((...args) => {
      const maintenance = configure(...args);
      const close = maintenance.close;
      vi.spyOn(maintenance, "close").mockImplementation((options) => {
        close(options);
        if (maintenanceFails) {
          throw maintenanceFailure;
        }
        return true;
      });
      return maintenance;
    });
    const ensureSchema = params.ensureSchema;
    params.ensureSchema = (db) => {
      ensureSchema(db);
      if (nativeFails) {
        vi.spyOn(db, "close").mockImplementation(throwing(nativeFailure));
      }
      throw failure;
    };
    const caught = attemptAcquisition(params);
    const db = expectDefined(opened.at(-1), "failed acquisition");
    expectAggregate(caught, failure, [
      failure,
      ...(maintenanceFails ? [maintenanceFailure] : []),
      ...(nativeFails ? [nativeFailure] : []),
    ]);
    expectReleased(db, maintenanceOwnerCount, nativeFails);
    expect(cache.getOpenClawStateDatabaseIfOpenAtPath(params.pathname)).toBeUndefined();
    if (nativeFails) {
      const healthy = acquire({
        ...params,
        pathname: path.join(path.dirname(params.pathname), "healthy.sqlite"),
        ensureSchema,
      });
      cache.publishOpenClawStateDatabase(healthy, params.env);
      expect(() => cache.closeOpenClawStateDatabase()).toThrow(
        maintenanceFails ? AggregateError : nativeFailure,
      );
      expect(healthy.db.isOpen).toBe(false);
      expect(cache.isOpenClawStateDatabaseOpen()).toBe(false);
      expect(db.isOpen).toBe(true);
    }
    vi.restoreAllMocks();
    await expectSuccessfulReopen({
      ...params,
      ensureSchema: () => {},
    });
    // Failed close remains discoverable only to disposal, never ordinary acquisition.
    cache.closeOpenClawStateDatabaseByPath(params.pathname);
    expect(db.isOpen).toBe(false);
  },
);

it.each([
  { terminal: "schema", cacheFails: false },
  { terminal: "integrity", cacheFails: true },
])(
  "latches $terminal failure without retrying cleanup (cache failure: $cacheFails)",
  ({ terminal, cacheFails }) => {
    const {
      params,
      open,
      openNative,
      openTracked,
      opened,
      maintenanceOwnerCount,
      targetLocations,
    } = acquisitionFixture();
    {
      using seed = openNative(params.pathname);
      if (terminal === "schema") {
        seed.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
      } else {
        seed.exec(`PRAGMA foreign_keys = OFF;
          CREATE TABLE parents (id INTEGER PRIMARY KEY);
          CREATE TABLE children (parent_id INTEGER REFERENCES parents(id));
          INSERT INTO children VALUES (1);`);
      }
    }
    const nativeFailure = new Error("native close refused");
    const cacheFailure = new Error("Kysely cleanup refused");
    const failedClose = vi.fn(throwing(nativeFailure));
    open.mockImplementation((...args) => {
      const db = openTracked(...args);
      if (targetLocations.has(args[0])) {
        vi.spyOn(db, "close").mockImplementation(failedClose);
      }
      return db;
    });
    if (cacheFails) {
      vi.spyOn(kyselyCache, "clearNodeSqliteKyselyCacheForDatabase").mockImplementationOnce(
        throwing(cacheFailure),
      );
    }
    const ensureSchema = vi.fn();
    const caught = attemptAcquisition({
      ...params,
      ensureSchema,
      recordOpenFailure: recordFailure,
    });
    const db = expectDefined(opened.at(-1), "terminal failed acquisition");
    const terminalFailure = expectDefined(
      cache.getOpenClawStateDatabaseRecordedFailure(params.pathname),
      "latched terminal failure",
    );
    expect(terminalFailure.name).toBe(
      terminal === "schema" ? "SqliteSchemaVersionError" : "SqliteIntegrityError",
    );
    expect(terminalFailure.message).toContain(
      terminal === "schema"
        ? `uses newer schema version ${SCHEMA_VERSION + 1}`
        : "foreign_key_check failed",
    );
    expectAggregate(caught, terminalFailure, [
      terminalFailure,
      ...(cacheFails ? [cacheFailure] : []),
      nativeFailure,
    ]);
    expect(failedClose).toHaveBeenCalledOnce();
    expect(ensureSchema).not.toHaveBeenCalled();
    expect(db.isOpen).toBe(true);
    expect(cache.isOpenClawStateDatabaseOpen(params.pathname)).toBe(false);
    expect(() => cache.assertOpenClawStateDatabaseOpenAllowed(params.pathname)).toThrow(
      terminalFailure,
    );
    expect(maintenanceOwnerCount()).toBe(0);
    vi.restoreAllMocks();
    expect(cache.closeOpenClawStateDatabaseByPath(params.pathname)).toBe(true);
    expect(db.isOpen).toBe(false);
    expect(cache.getOpenClawStateDatabaseRecordedFailure(params.pathname)).toBe(terminalFailure);
  },
);
