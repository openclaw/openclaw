import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import * as kyselyCache from "../infra/kysely-sync-cache-state.js";
import * as kyselySync from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as busyTimeout from "../infra/sqlite-busy-timeout.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import { setConsoleSubsystemFilter } from "../logging/console.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  openClawStateDatabaseCache,
  recordOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import * as initialization from "./openclaw-state-db-initialization.js";
import { openUnpublishedStateDatabase } from "./openclaw-state-db-open.js";
import * as permissions from "./openclaw-state-db-permissions.js";

describe("unpublished state database acquisition", () => {
  const databases = new Set<DatabaseSync>();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      openClawStateDatabaseCache.closeOpenClawStateDatabaseForTest();
      for (const db of databases) {
        if (db.isOpen) {
          closeTrackedStateDatabase(db);
        }
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
      scopes.mock.results.filter(
        (result) => result.type === "return" && !result.value.signal.aborted,
      ).length;
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
    const seed = openUnpublishedStateDatabase(params);
    seed.db.exec("INSERT INTO payload VALUES ('committed');");
    seed.walMaintenance.close();
    closeTrackedStateDatabase(seed.db);
    const opened: DatabaseSync[] = [];
    const targetLocations = new Set([pathname, nodeSqlite.resolveExistingSqliteFileUri(pathname)]);
    const openNative = nodeSqlite.openNodeSqliteDatabase;
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = openNative(...args);
      databases.add(db);
      if (targetLocations.has(args[0])) {
        opened.push(db);
      }
      return db;
    });
    return { params, open, openNative, opened, maintenanceOwnerCount, targetLocations };
  }

  async function expectSuccessfulReopen(
    params: Parameters<typeof openUnpublishedStateDatabase>[0],
  ) {
    const maintenanceOwnerCount = observeMaintenanceOwners();
    const reopened = openUnpublishedStateDatabase(params);
    const prepare = vi.spyOn(reopened.db, "prepare");
    const exec = vi.spyOn(reopened.db, "exec");
    try {
      expect(reopened.db.prepare("SELECT value FROM payload").all()).toEqual([
        { value: "committed" },
      ]);
      expect(reopened.db.isOpen).toBe(true);
      expect(maintenanceOwnerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(prepare).toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
    } finally {
      reopened.walMaintenance.close();
      closeTrackedStateDatabase(reopened.db);
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
      const { params, open, openNative } = acquisitionFixture();
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
          const db = openNative(...args);
          databases.add(db);
          return db;
        });
      }

      let acquired: ReturnType<typeof openUnpublishedStateDatabase> | undefined;
      let failure: unknown;
      try {
        acquired = openUnpublishedStateDatabase(params);
      } catch (error) {
        failure = error;
      } finally {
        acquired?.walMaintenance.close();
        if (acquired) {
          closeTrackedStateDatabase(acquired.db);
        }
      }

      expect.soft(failure).toBeInstanceOf(Error);
      expect.soft(fs.existsSync(params.pathname)).toBe(false);
      expect.soft(fs.existsSync(sidecarPath)).toBe(true);
      if (fs.existsSync(sidecarPath)) {
        expect.soft(fs.readFileSync(sidecarPath)).toEqual(sidecarBytes);
      }
      expect
        .soft(
          fs
            .readdirSync(path.dirname(params.pathname))
            .filter((name) => name.includes(".orphaned-")),
        )
        .toEqual([]);
      const preserved = openNative(preservedPath, { readOnly: true });
      try {
        expect(preserved.prepare("SELECT value FROM payload").all()).toEqual([
          { value: "committed" },
        ]);
      } finally {
        closeTrackedStateDatabase(preserved);
      }
    },
  );

  it("refuses a replacement generation before running schema setup", () => {
    const { params, open, openNative } = acquisitionFixture();
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
      const database = openNative(...args);
      databases.add(database);
      return database;
    });
    let acquired: ReturnType<typeof openUnpublishedStateDatabase> | undefined;
    let failure: unknown;
    try {
      acquired = openUnpublishedStateDatabase(params);
    } catch (error) {
      failure = error;
    } finally {
      acquired?.walMaintenance.close();
      if (acquired) {
        closeTrackedStateDatabase(acquired.db);
      }
    }
    expect.soft(failure).toBeInstanceOf(Error);
    expect.soft(ensureSchema).not.toHaveBeenCalled();
    for (const [pathname, value] of [
      [preservedPath, "committed"],
      [params.pathname, "replacement"],
    ] as const) {
      const database = openNative(pathname, { readOnly: true });
      try {
        expect(database.prepare("SELECT value FROM payload").all()).toEqual([{ value }]);
      } finally {
        database.close();
      }
    }
  });

  it.each([false, true])(
    "keeps the same database after schema writes with platform file timestamps (existing schema: %s)",
    (existingSchema) => {
      const { params } = acquisitionFixture();
      const stat = fs.statSync;
      let ctimeAdvanceNs = 0n;
      vi.spyOn(fs, "statSync").mockImplementation((...args) => {
        const result = stat(...args);
        if (
          process.platform === "linux" &&
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
      const acquired = openUnpublishedStateDatabase({
        ...params,
        existingSchema,
        ensureSchema(db) {
          db.exec("CREATE INDEX idx_payload ON payload(value)");
          // Model coarse-clock old Linux hosts without depending on a timer tick.
          ctimeAdvanceNs += 1n;
        },
      });
      try {
        const after = fs.statSync(params.pathname, { bigint: true });
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
        if (process.platform === "linux") {
          expect(after.birthtimeNs).not.toBe(before.birthtimeNs);
        }
        expect(acquired.db.prepare("PRAGMA index_info(idx_payload)").all()).toEqual([
          { seqno: 0, cid: 0, name: "value" },
        ]);
        expect(acquired.db.prepare("SELECT value FROM payload").all()).toEqual([
          { value: "committed" },
        ]);
      } finally {
        acquired.walMaintenance.close();
        closeTrackedStateDatabase(acquired.db);
      }
    },
  );

  it("does not recreate a removed parent during existing database hardening", () => {
    const { params, openNative } = acquisitionFixture();
    const directory = path.dirname(params.pathname);
    const preservedDirectory = path.join(tempDirs.make("openclaw-state-preserved-"), "state");
    const harden = permissions.ensureOpenClawStatePermissions;
    vi.spyOn(permissions, "ensureOpenClawStatePermissions").mockImplementationOnce((...args) => {
      fs.renameSync(directory, preservedDirectory);
      return harden(...args);
    });
    let acquired: ReturnType<typeof openUnpublishedStateDatabase> | undefined;
    try {
      acquired = openUnpublishedStateDatabase(params);
    } catch {
      // Refusal must not recreate any path, regardless of the SQLite cleanup diagnostic.
    } finally {
      acquired?.walMaintenance.close();
      if (acquired) {
        closeTrackedStateDatabase(acquired.db);
      }
    }
    expect.soft(fs.existsSync(directory)).toBe(false);
    const preserved = openNative(path.join(preservedDirectory, path.basename(params.pathname)), {
      readOnly: true,
    });
    try {
      expect(preserved.prepare("SELECT value FROM payload").all()).toEqual([
        { value: "committed" },
      ]);
    } finally {
      preserved.close();
    }
  });

  it("checkpoints the admitted database without opening auxiliary databases", () => {
    const { params, open } = acquisitionFixture();
    const database = openUnpublishedStateDatabase(params);
    try {
      open.mockClear();
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(open).not.toHaveBeenCalled();
    } finally {
      database.walMaintenance.close();
      closeTrackedStateDatabase(database.db);
    }
  });

  it("records and reports SQLite errors from scheduled shared-state checkpoints", async () => {
    await withEnvAsync({ OPENCLAW_LOG_LEVEL: undefined }, async () => {
      const previousLogging = { ...loggingState };
      const warn = vi.fn<(line: string) => void>();
      try {
        setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
        setConsoleSubsystemFilter(["state/db"]);
        loggingState.forceConsoleToStderr = false;
        loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
        const { params } = acquisitionFixture();
        const database = openUnpublishedStateDatabase(params);
        const prepare = database.db.prepare.bind(database.db);
        const checkpointFailure = new Error("checkpoint storage unavailable");
        const intercepted = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
          if (sql === "PRAGMA wal_checkpoint(PASSIVE);") {
            throw checkpointFailure;
          }
          return prepare(sql);
        });
        try {
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
          expect(database.walMaintenance.health).toMatchObject({
            state: "complete",
            warning: false,
          });
        } finally {
          intercepted.mockRestore();
          database.walMaintenance.close();
          closeTrackedStateDatabase(database.db);
        }
      } finally {
        Object.assign(loggingState, previousLogging);
      }
    });
  });

  it.each([
    "statement cache",
    "initial busy timeout",
    "busy timeout read",
    "busy timeout finalization",
    "schema",
    "hardening",
  ])("releases every acquisition after failed %s and preserves committed state", async (phase) => {
    const { params, open, openNative, opened, maintenanceOwnerCount, targetLocations } =
      acquisitionFixture();
    const failure = new Error(`${phase} failed`);
    if (phase === "statement cache") {
      vi.spyOn(kyselySync, "enableNodeSqliteKyselyStatementCache").mockImplementation(() => {
        throw failure;
      });
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
    } else {
      open.mockImplementation((...args) => {
        const db = openNative(...args);
        databases.add(db);
        if (targetLocations.has(args[0])) {
          opened.push(db);
        }
        if (!targetLocations.has(args[0])) {
          return db;
        }
        if (phase === "initial busy timeout") {
          vi.spyOn(db, "exec").mockImplementationOnce(() => {
            throw failure;
          });
        } else {
          const prepare = db.prepare.bind(db);
          vi.spyOn(db, "prepare").mockImplementation((sql) => {
            if (sql === "PRAGMA busy_timeout") {
              throw failure;
            }
            return prepare(sql);
          });
        }
        return db;
      });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => openUnpublishedStateDatabase(params)).toThrow(failure);
      const db = expectDefined(opened.at(-1), "failed acquisition");
      expect(db.isOpen).toBe(false);
      expect(kyselyCache.kyselyByDatabase.has(db)).toBe(false);
      expect(maintenanceOwnerCount()).toBe(0);
    }
    expect(params.recordOpenFailure).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    await expectSuccessfulReopen({
      ...params,
      ensureSchema: (db) => {
        expect(db.prepare("SELECT value FROM payload").get()).toEqual({ value: "committed" });
      },
    });
  });

  it.each(
    ["schema", "hardening"].flatMap((phase) =>
      ["maintenance", "native", "both"].map((cleanupFailure) => ({ phase, cleanupFailure })),
    ),
  )(
    "preserves the $phase error and $cleanupFailure cleanup failures with a disposal-only owner",
    async ({ phase, cleanupFailure }) => {
      const { params, opened, maintenanceOwnerCount } = acquisitionFixture();
      const failure = new Error(`${phase} failed`);
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
      const harden = permissions.ensureOpenClawStatePermissions;
      let calls = 0;
      vi.spyOn(permissions, "ensureOpenClawStatePermissions").mockImplementation((...args) => {
        harden(...args);
        if (++calls === 2 && phase === "hardening") {
          throw failure;
        }
      });
      const ensureSchema = params.ensureSchema;
      params.ensureSchema = (db) => {
        ensureSchema(db);
        if (nativeFails) {
          vi.spyOn(db, "close").mockImplementation(() => {
            throw nativeFailure;
          });
        }
        if (phase === "schema") {
          throw failure;
        }
      };
      let caught: unknown;
      try {
        openUnpublishedStateDatabase(params);
      } catch (error) {
        caught = error;
      }
      const db = expectDefined(opened.at(-1), "failed acquisition");
      expect(caught).toBeInstanceOf(AggregateError);
      expect(caught).toMatchObject({
        cause: failure,
        errors: [
          failure,
          ...(maintenanceFails ? [maintenanceFailure] : []),
          ...(nativeFails ? [nativeFailure] : []),
        ],
      });
      expect(db.isOpen).toBe(nativeFails);
      expect(kyselyCache.kyselyByDatabase.has(db)).toBe(false);
      expect(maintenanceOwnerCount()).toBe(0);
      expect(
        openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(params.pathname),
      ).toBeUndefined();
      if (nativeFails) {
        const healthy = openUnpublishedStateDatabase({
          ...params,
          pathname: path.join(path.dirname(params.pathname), "healthy.sqlite"),
          ensureSchema,
        });
        openClawStateDatabaseCache.publishOpenClawStateDatabase(healthy, params.env);
        expect(() => openClawStateDatabaseCache.closeOpenClawStateDatabase()).toThrow(
          maintenanceFails ? AggregateError : nativeFailure,
        );
        expect(healthy.db.isOpen).toBe(false);
        expect(openClawStateDatabaseCache.isOpenClawStateDatabaseOpen()).toBe(false);
        expect(db.isOpen).toBe(true);
      }
      vi.restoreAllMocks();
      await expectSuccessfulReopen({
        ...params,
        ensureSchema: () => {},
      });
      // Failed close remains discoverable only to disposal, never ordinary acquisition.
      openClawStateDatabaseCache.closeOpenClawStateDatabaseByPath(params.pathname);
      expect(db.isOpen).toBe(false);
    },
  );

  it.each(
    ["schema", "integrity"].flatMap((terminal) =>
      [false, true].map((cacheFails) => ({ terminal, cacheFails })),
    ),
  )(
    "latches the real $terminal failure without retrying retained native cleanup (cache failure: $cacheFails)",
    ({ terminal, cacheFails }) => {
      const { params, open, openNative, opened, maintenanceOwnerCount, targetLocations } =
        acquisitionFixture();
      const seed = openNative(params.pathname);
      try {
        if (terminal === "schema") {
          seed.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
        } else {
          seed.exec(`PRAGMA foreign_keys = OFF;
          CREATE TABLE parents (id INTEGER PRIMARY KEY);
          CREATE TABLE children (parent_id INTEGER REFERENCES parents(id));
          INSERT INTO children VALUES (1);`);
        }
      } finally {
        seed.close();
      }
      const nativeFailure = new Error("native close refused");
      const cacheFailure = new Error("Kysely cleanup refused");
      const failedClose = vi.fn(() => {
        throw nativeFailure;
      });
      open.mockImplementation((...args) => {
        const db = openNative(...args);
        databases.add(db);
        if (targetLocations.has(args[0])) {
          opened.push(db);
          vi.spyOn(db, "close").mockImplementation(failedClose);
        }
        return db;
      });
      if (cacheFails) {
        vi.spyOn(kyselyCache, "clearNodeSqliteKyselyCacheForDatabase").mockImplementationOnce(
          () => {
            throw cacheFailure;
          },
        );
      }
      const ensureSchema = vi.fn();
      let caught: unknown;
      try {
        openUnpublishedStateDatabase({
          ...params,
          ensureSchema,
          recordOpenFailure: recordOpenClawStateDatabaseOpenFailure,
        });
      } catch (error) {
        caught = error;
      }
      const db = expectDefined(opened.at(-1), "terminal failed acquisition");
      const terminalFailure = expectDefined(
        openClawStateDatabaseCache.getOpenClawStateDatabaseRecordedFailure(params.pathname),
        "latched terminal failure",
      );
      expect(terminalFailure.name).toBe(
        terminal === "schema" ? "SqliteSchemaVersionError" : "SqliteIntegrityError",
      );
      expect(terminalFailure.message).toContain(
        terminal === "schema"
          ? `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`
          : "foreign_key_check failed",
      );
      expect(caught).toBeInstanceOf(AggregateError);
      expect(caught).toMatchObject({
        cause: terminalFailure,
        errors: [terminalFailure, ...(cacheFails ? [cacheFailure] : []), nativeFailure],
      });
      expect(failedClose).toHaveBeenCalledOnce();
      expect(ensureSchema).not.toHaveBeenCalled();
      expect(db.isOpen).toBe(true);
      expect(openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(params.pathname)).toBe(false);
      expect(() =>
        openClawStateDatabaseCache.assertOpenClawStateDatabaseOpenAllowed(params.pathname),
      ).toThrow(terminalFailure);
      expect(maintenanceOwnerCount()).toBe(0);
      vi.restoreAllMocks();
      expect(openClawStateDatabaseCache.closeOpenClawStateDatabaseByPath(params.pathname)).toBe(
        true,
      );
      expect(db.isOpen).toBe(false);
      expect(
        openClawStateDatabaseCache.getOpenClawStateDatabaseRecordedFailure(params.pathname),
      ).toBe(terminalFailure);
    },
  );
});
