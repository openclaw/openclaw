import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { kyselyByDatabase } from "../infra/kysely-sync-cache-state.js";
import * as kyselySync from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as busyTimeout from "../infra/sqlite-busy-timeout.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
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
          db.close();
        }
      }
      databases.clear();
      vi.clearAllTimers();
      vi.useRealTimers();
      cleanup();
    });
  });

  function acquisitionFixture() {
    vi.useFakeTimers();
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
    seed.db.close();
    const openNative = nodeSqlite.openNodeSqliteDatabase;
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = openNative(...args);
      databases.add(db);
      return db;
    });
    return { params, open, openNative };
  }

  function expectSuccessfulReopen(params: Parameters<typeof openUnpublishedStateDatabase>[0]) {
    const reopened = openUnpublishedStateDatabase(params);
    try {
      expect(reopened.db.prepare("SELECT value FROM payload").all()).toEqual([
        { value: "committed" },
      ]);
      expect(reopened.db.isOpen).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      reopened.walMaintenance.close();
      reopened.db.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  }

  it.each([
    "statement cache",
    "initial busy timeout",
    "busy timeout read",
    "busy timeout finalization",
    "schema",
    "hardening",
  ])("releases every acquisition after failed %s and preserves committed state", (phase) => {
    const { params, open, openNative } = acquisitionFixture();
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
      const db = expectDefined([...databases].at(-1), "failed acquisition");
      expect(db.isOpen).toBe(false);
      expect(kyselyByDatabase.has(db)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
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
      const { params } = acquisitionFixture();
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
      const db = expectDefined([...databases].at(-1), "failed acquisition");
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
      expect(kyselyByDatabase.has(db)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(
        openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(params.pathname),
      ).toBeUndefined();
      if (nativeFails) {
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
    },
  );
});
