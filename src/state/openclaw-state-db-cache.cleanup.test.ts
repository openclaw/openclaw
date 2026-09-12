import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as kyselyCache from "../infra/kysely-sync-cache-state.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import { openClawStateDatabaseCache as cache } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cache.closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

describe("shared-state disposal ownership", () => {
  it.each(["path", "all", "corruption"] as const)(
    "retains a failed native close for disposal without a cache hit after %s retirement",
    (scope) => {
      const root = tempDirs.make("openclaw-state-disposal-");
      const owner = openOpenClawStateDatabase({ path: path.join(root, "failed.sqlite") });
      const healthy = openOpenClawStateDatabase({ path: path.join(root, "healthy.sqlite") });
      owner.db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('original')");
      const failure = new Error("native close refused");
      const close = vi.spyOn(owner.db, "close").mockImplementation(() => {
        throw failure;
      });
      if (scope === "corruption") {
        expect(cache.evictCachedOpenClawStateDatabase(owner)).toBe(true);
      } else {
        expect(() =>
          scope === "path"
            ? cache.closeOpenClawStateDatabaseByPath(owner.path)
            : cache.closeOpenClawStateDatabase(),
        ).toThrow(failure);
      }
      expect(owner.db.isOpen).toBe(true);
      expect(cache.getOpenClawStateDatabaseIfOpenAtPath(owner.path)).toBeUndefined();
      expect(kyselyCache.kyselyByDatabase.has(owner.db)).toBe(false);
      expect(() =>
        acquireStateDatabaseHandleExclusion({ databasePath: owner.path, busyTimeoutMs: 0 }),
      ).toThrow(/state-handles/);
      expect(healthy.db.isOpen).toBe(scope !== "all");
      close.mockRestore();
      expect(cache.closeOpenClawStateDatabaseByPath(owner.path)).toBe(true);
      expect(owner.db.isOpen).toBe(false);
      const exclusion = acquireStateDatabaseHandleExclusion({
        databasePath: owner.path,
        busyTimeoutMs: 0,
      });
      exclusion.release();
      const reopened = openOpenClawStateDatabase({ path: owner.path });
      expect(reopened.db.prepare("SELECT value FROM retained").all()).toEqual([
        { value: "original" },
      ]);
    },
  );

  it("attempts native close and other owners after maintenance and Kysely cleanup failures", () => {
    const root = tempDirs.make("openclaw-state-cleanup-failures-");
    const owner = openOpenClawStateDatabase({ path: path.join(root, "failed.sqlite") });
    const healthy = openOpenClawStateDatabase({ path: path.join(root, "healthy.sqlite") });
    const maintenanceFailure = new Error("maintenance failed");
    const cacheFailure = new Error("Kysely disposal failed");
    const closeMaintenance = owner.walMaintenance.close;
    vi.spyOn(owner.walMaintenance, "close").mockImplementation((options) => {
      closeMaintenance(options);
      throw maintenanceFailure;
    });
    vi.spyOn(kyselyCache, "clearNodeSqliteKyselyCacheForDatabase").mockImplementationOnce(() => {
      throw cacheFailure;
    });
    let caught: unknown;
    try {
      cache.closeOpenClawStateDatabase();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      cause: maintenanceFailure,
      errors: [maintenanceFailure, cacheFailure],
    });
    expect(owner.db.isOpen).toBe(false);
    expect(healthy.db.isOpen).toBe(false);
    expect(cache.getOpenClawStateDatabaseIfOpenAtPath(owner.path)).toBeUndefined();
    const exclusion = acquireStateDatabaseHandleExclusion({
      databasePath: owner.path,
      busyTimeoutMs: 0,
    });
    exclusion.release();
  });
});
