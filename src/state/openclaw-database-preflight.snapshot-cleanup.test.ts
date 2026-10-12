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

const busy = vi.hoisted(() => ({ roots: new Set<string>(), code: "EBUSY" }));

// Bun without qualified native close keeps the private copy open after logical close.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rm: typeof actual.promises.rm = async (target, options) => {
    if ([...busy.roots].some((root) => String(target).startsWith(root))) {
      throw Object.assign(new Error(`${busy.code}: resource busy or locked, rm '${target}'`), {
        code: busy.code,
      });
    }
    return await actual.promises.rm(target, options);
  };
  return {
    ...actual,
    default: { ...actual, promises: { ...actual.promises, rm } },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  busy.roots.clear();
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
    busy.code = code;
    let cleanupRoot = "";
    const prepare = snapshots.prepareSqliteReadOnlyLocation;
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
      async (pathname, options) => {
        const prepared = await prepare(pathname, options);
        cleanupRoot = prepared.cleanupRoot ?? path.dirname(prepared.location);
        busy.roots.add(cleanupRoot);
        if (read === "failure") {
          fs.writeFileSync(prepared.location, "not a database");
        }
        return prepared;
      },
    );

    const outcome = await preflightOpenClawDatabaseSchemas({
      env,
      scope: "state",
      ...(caller === "signal" ? { signal: new AbortController().signal } : {}),
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    expect(cleanupRoot).not.toBe("");
    if (settles === "deferred") {
      expect(outcome).toEqual({ value: { incompatible: [], indeterminate: [] } });
      expect(warn).toHaveBeenCalledWith(
        { path: cleanupRoot, errorCode: "EBUSY" },
        "SQLite snapshot cleanup deferred until native SQLite resources are released.",
      );
    } else {
      expect(outcome).toEqual({ error: expect.any(Error) });
      expect(warn).not.toHaveBeenCalled();
    }
    // The registry keeps custody and removes the private copy once native resources release.
    expect(fs.existsSync(cleanupRoot)).toBe(true);
    busy.roots.clear();
    await cleanupSnapshotOperations();
    expect(fs.existsSync(cleanupRoot)).toBe(false);
  },
);
