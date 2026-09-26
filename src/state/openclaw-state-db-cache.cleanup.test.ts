import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as kyselyCache from "../infra/kysely-sync-cache-state.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import {
  openClawStateDatabaseCache as cache,
  readOpenClawStateWalHealth,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cache.closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  });
});

describe("shared-state disposal ownership", () => {
  it.each(["canonical", "borrow"] as const)(
    "retries released-borrow cleanup through the %s owner without closing its replacement",
    (retry) => {
      const root = tempDirs.make("openclaw-state-borrow-cleanup-");
      const owner = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
      const borrow = retainOpenClawStateDatabase(owner);
      const failure = new Error("maintenance cleanup callback failed");
      const closeMaintenance = owner.walMaintenance.close;
      vi.spyOn(owner.walMaintenance, "close").mockImplementationOnce((options) => {
        closeMaintenance(options);
        throw failure;
      });

      try {
        expect(() => borrow.release()).toThrow(failure);
        expect(owner.db.isOpen).toBe(false);
        if (retry === "canonical") {
          expect(cache.closeOpenClawStateDatabaseByPath(owner.path)).toBe(true);
        } else {
          expect(() => borrow.release()).not.toThrow();
        }
        const replacement = openOpenClawStateDatabase({ path: owner.path });
        borrow.release();
        expect(replacement.db.isOpen).toBe(true);
      } finally {
        borrow.release();
      }
    },
  );

  it("reads only recorded WAL health and forgets it when the database retires", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-state-wal-health-"));
    expect(readOpenClawStateWalHealth()).toBeUndefined();
    const owner = openOpenClawStateDatabase();
    expect(readOpenClawStateWalHealth()).toBeUndefined();
    expect(owner.walMaintenance.checkpoint()).toBe(true);
    const prepare = vi.spyOn(owner.db, "prepare");
    const recorded = readOpenClawStateWalHealth();
    expect(recorded).toMatchObject({ state: "complete", warning: false });
    expect(prepare).not.toHaveBeenCalled();
    if (recorded) {
      recorded.warning = true;
    }
    expect(readOpenClawStateWalHealth()?.warning).toBe(false);
    cache.closeOpenClawStateDatabaseByPath(owner.path);
    expect(readOpenClawStateWalHealth()).toBeUndefined();
  });
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
