import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteRuntime from "../infra/bun-sqlite-library.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import * as logger from "../logging/logger.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const busyRoots = new Set<string>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  busyRoots.clear();
  await cleanupSnapshotOperations();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

// Gateway startup passes a signal; `gateway status --deep` does not.
it.each([
  { capable: false, code: "EBUSY", read: "success", caller: "signal", settles: "deferred" },
  { capable: false, code: "EBUSY", read: "success", caller: "none", settles: "deferred" },
  { capable: true, code: "EBUSY", read: "success", caller: "signal", settles: "rejected" },
  { capable: true, code: "EBUSY", read: "success", caller: "none", settles: "rejected" },
  { capable: false, code: "EPERM", read: "success", caller: "signal", settles: "rejected" },
  { capable: false, code: "EBUSY", read: "failure", caller: "signal", settles: "rejected" },
] as const)(
  "settles state preflight with $code cleanup after read $read (native close capable: $capable, caller signal: $caller)",
  async ({ capable, code, read, caller, settles }) => {
    const remove = fs.promises.rm;
    // Bun can retain native resources after logical close; fail only this snapshot's removal.
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if ([...busyRoots].some((root) => String(target).startsWith(root))) {
        throw Object.assign(new Error(`${code}: resource busy or locked, rm '${String(target)}'`), {
          code,
        });
      }
      return remove(target, options);
    });
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("preflight-snapshot-cleanup-") };
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    vi.spyOn(sqliteRuntime, "getSqliteRuntimeCapabilities").mockReturnValue({
      ...sqliteRuntime.getSqliteRuntimeCapabilities(),
      explicitSqliteCloseReleasesNativeResources: capable,
    });
    const warn = vi.fn();
    const childLogger = logger.getChildLogger;
    vi.spyOn(logger, "getChildLogger").mockImplementation((bindings, options) =>
      bindings?.subsystem === "infra/sqlite-snapshot"
        ? ({ warn } as unknown as ReturnType<typeof childLogger>)
        : childLogger(bindings, options),
    );
    let cleanupRoot = "";
    const prepare = snapshots.prepareSqliteReadOnlyLocation;
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
      async (pathname, options) => {
        const prepared = await prepare(pathname, options);
        cleanupRoot = prepared.cleanupRoot ?? path.dirname(prepared.location);
        busyRoots.add(cleanupRoot);
        if (read === "failure") {
          fs.writeFileSync(prepared.location, "not a database");
        }
        return prepared;
      },
    );

    const outcome = preflightOpenClawDatabaseSchemas({
      env,
      scope: "state",
      ...(caller === "signal" ? { signal: new AbortController().signal } : {}),
    });

    if (settles === "deferred") {
      await expect(outcome).resolves.toEqual({ incompatible: [], indeterminate: [] });
      expect(warn).toHaveBeenCalledWith(
        { path: cleanupRoot, errorCode: "EBUSY" },
        "SQLite snapshot cleanup deferred until native SQLite resources are released.",
      );
    } else {
      await expect(outcome).rejects.toBeInstanceOf(Error);
      expect(warn).not.toHaveBeenCalled();
    }
    expect(cleanupRoot).not.toBe("");
    // The registry keeps custody and removes the private copy once native resources release.
    expect(fs.existsSync(cleanupRoot)).toBe(true);
    busyRoots.clear();
    await cleanupSnapshotOperations();
    expect(fs.existsSync(cleanupRoot)).toBe(false);
  },
);
