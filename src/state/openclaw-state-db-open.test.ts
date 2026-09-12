import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as kyselyCache from "../infra/kysely-sync-cache-state.js";
import * as kyselySync from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as busyTimeout from "../infra/sqlite-busy-timeout.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import {
  acquireStateDatabaseHandleExclusion,
  resolveStateDatabaseCoordinatorPath,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import {
  openClawStateDatabaseCache,
  recordOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { openUnpublishedStateDatabase } from "./openclaw-state-db-open.js";
import * as permissions from "./openclaw-state-db-permissions.js";

describe("unpublished state database acquisition", () => {
  const databases = new Set<DatabaseSync>();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      vi.restoreAllMocks();
      openClawStateDatabaseCache.closeOpenClawStateDatabaseForTest();
      for (const db of databases) {
        if (db.isOpen) {
          closeTrackedStateDatabase(db);
        }
      }
      databases.clear();
      // Expire idle coordinator handles before discarding the fake clock.
      vi.runOnlyPendingTimers();
      vi.clearAllTimers();
      vi.useRealTimers();
      cleanup();
    });
  });

  function observeMaintenanceTimers() {
    const scheduled = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    return () =>
      scheduled.mock.results.filter(
        (result) =>
          result.type === "return" && !cleared.mock.calls.some(([timer]) => timer === result.value),
      ).length;
  }

  function acquisitionFixture() {
    vi.useFakeTimers();
    const maintenanceTimerCount = observeMaintenanceTimers();
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
    const openNative = nodeSqlite.openNodeSqliteDatabase;
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = openNative(...args);
      databases.add(db);
      if (args[0] === pathname) {
        opened.push(db);
      }
      return db;
    });
    return { params, open, openNative, opened, maintenanceTimerCount };
  }

  function expectSuccessfulReopen(params: Parameters<typeof openUnpublishedStateDatabase>[0]) {
    const maintenanceTimerCount = observeMaintenanceTimers();
    const reopened = openUnpublishedStateDatabase(params);
    try {
      expect(reopened.db.prepare("SELECT value FROM payload").all()).toEqual([
        { value: "committed" },
      ]);
      expect(reopened.db.isOpen).toBe(true);
      expect(maintenanceTimerCount()).toBe(1);
    } finally {
      reopened.walMaintenance.close();
      closeTrackedStateDatabase(reopened.db);
    }
    expect(maintenanceTimerCount()).toBe(0);
  }

  it("keeps the admitted coordinator directory for delayed maintenance", () => {
    const { params, open } = acquisitionFixture();
    const runtimeDirectory = tempDirs.make("openclaw-maintenance-scope-");
    const database = withStateDatabaseCoordinatorRuntimeDirectory(runtimeDirectory, () =>
      openUnpublishedStateDatabase(params),
    );
    const coordinatorPath = resolveStateDatabaseCoordinatorPath({
      databasePath: params.pathname,
      runtimeDirectory,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    });
    try {
      open.mockClear();
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(open.mock.calls.map(([location]) => location)).toContain(coordinatorPath);
    } finally {
      database.walMaintenance.close();
      closeTrackedStateDatabase(database.db);
    }
  });

  it.each([
    "statement cache",
    "initial busy timeout",
    "busy timeout read",
    "busy timeout finalization",
    "schema",
    "hardening",
  ])("releases every acquisition after failed %s and preserves committed state", (phase) => {
    const { params, open, openNative, opened, maintenanceTimerCount } = acquisitionFixture();
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
        if (args[0] === params.pathname) {
          opened.push(db);
        }
        // Coordinator connections are separate acquisitions, not this failure target.
        if (args[0] !== params.pathname) {
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
      expect(maintenanceTimerCount()).toBe(0);
    }
    expect(params.recordOpenFailure).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expectSuccessfulReopen({
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
    ({ phase, cleanupFailure }) => {
      const { params, opened, maintenanceTimerCount } = acquisitionFixture();
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
      expect(maintenanceTimerCount()).toBe(0);
      expect(
        openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(params.pathname),
      ).toBeUndefined();
      if (nativeFails) {
        expect(() =>
          acquireStateDatabaseHandleExclusion({ databasePath: params.pathname, busyTimeoutMs: 0 }),
        ).toThrow(/state-handles/);
        const healthy = openUnpublishedStateDatabase({
          ...params,
          pathname: path.join(path.dirname(params.pathname), "healthy.sqlite"),
          ensureSchema,
        });
        openClawStateDatabaseCache.publishOpenClawStateDatabase(healthy);
        expect(() => openClawStateDatabaseCache.closeOpenClawStateDatabase()).toThrow(
          maintenanceFails ? AggregateError : nativeFailure,
        );
        expect(healthy.db.isOpen).toBe(false);
        expect(openClawStateDatabaseCache.isOpenClawStateDatabaseOpen()).toBe(false);
        expect(db.isOpen).toBe(true);
      }
      vi.restoreAllMocks();
      expectSuccessfulReopen({
        ...params,
        ensureSchema: () => {},
      });
      // Failed close remains discoverable only to disposal, never ordinary acquisition.
      openClawStateDatabaseCache.closeOpenClawStateDatabaseByPath(params.pathname);
      expect(db.isOpen).toBe(false);
      const exclusion = acquireStateDatabaseHandleExclusion({
        databasePath: params.pathname,
        busyTimeoutMs: 0,
      });
      exclusion.release();
    },
  );

  it.each(
    ["schema", "integrity"].flatMap((terminal) =>
      [false, true].map((cacheFails) => ({ terminal, cacheFails })),
    ),
  )(
    "latches the real $terminal failure without retrying retained native cleanup (cache failure: $cacheFails)",
    ({ terminal, cacheFails }) => {
      const { params, open, openNative, opened, maintenanceTimerCount } = acquisitionFixture();
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
        if (args[0] === params.pathname) {
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
        openClawStateDatabaseCache.getOpenClawStateDatabaseRuntimeFailure(params.pathname),
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
      expect(() =>
        acquireStateDatabaseHandleExclusion({ databasePath: params.pathname, busyTimeoutMs: 0 }),
      ).toThrow(/state-handles/);
      expect(maintenanceTimerCount()).toBe(0);
      vi.restoreAllMocks();
      expect(openClawStateDatabaseCache.closeOpenClawStateDatabaseByPath(params.pathname)).toBe(
        true,
      );
      expect(db.isOpen).toBe(false);
      const exclusion = acquireStateDatabaseHandleExclusion({
        databasePath: params.pathname,
        busyTimeoutMs: 0,
      });
      exclusion.release();
      expect(
        openClawStateDatabaseCache.getOpenClawStateDatabaseRuntimeFailure(params.pathname),
      ).toBe(terminalFailure);
    },
  );
});
