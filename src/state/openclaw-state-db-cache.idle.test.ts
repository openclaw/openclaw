import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import * as schemaFacts from "../infra/sqlite-schema-facts.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  borrowOpenClawStateDatabaseForAsyncRead,
  openClawStateDatabaseCache as cache,
  retainOpenClawStateDatabase,
  retainOpenClawStateDatabaseForIdle,
  retainOpenClawStateDatabaseForIndependentRead,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase, runWithOpenClawStateBusyTimeout } from "./openclaw-state-db.js";
import { prepareLeaseDatabase, resolveLeaseDatabasePath } from "./openclaw-state-lease-storage.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    cache.closeOpenClawStateDatabaseForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });
});
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));

type Database = ReturnType<typeof openOpenClawStateDatabase>;
function advance(database: Database, ms: number, isOpen: boolean) {
  vi.advanceTimersByTime(ms);
  expect(database.db.isOpen).toBe(isOpen);
}

function fixture() {
  const pathname = path.join(tempDirs.make("shared-idle-"), "state.sqlite");
  return { pathname, open: () => openOpenClawStateDatabase({ path: pathname }) };
}

it("reuses the admitted handle for lease storage without entering a schema read scope", () => {
  const { pathname, open } = fixture();
  const database = open();
  const nativeOpen = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  const readScope = vi.spyOn(schemaFacts, "runSqliteReadOperationSync");
  const leaseDatabase = { scope: "shared" as const, options: { path: pathname } };
  for (let index = 0; index < 2; index++) {
    prepareLeaseDatabase(leaseDatabase);
    expect(resolveLeaseDatabasePath(leaseDatabase)).toBe(pathname);
    expect(open()).toBe(database);
  }
  expect(nativeOpen).not.toHaveBeenCalled();
  expect(readScope.mock.calls.filter(([db]) => db === database.db)).toHaveLength(0);
});

it.each(["path", "supplied", "busy-timeout"] as const)(
  "reuses shared-state handles until 30 minutes after their last %s acquisition",
  (acquisition) => {
    const { pathname, open: acquirePath } = fixture();
    const fileUri = nodeSqlite.resolveExistingSqliteFileUri(pathname);
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    const first = acquirePath();
    const acquire = () =>
      acquisition === "busy-timeout"
        ? runWithOpenClawStateBusyTimeout((database) => database, { database: first }, 0)
        : openOpenClawStateDatabase(
            acquisition === "supplied" ? { database: first } : { path: pathname },
          );
    for (let index = 0; index < 100; index++) {
      expect(acquire()).toBe(first);
    }
    const opens = () =>
      open.mock.calls.filter(([filename]) => filename === pathname || filename === fileUri).length;
    expect(opens()).toBe(1);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(acquire()).toBe(first);
    advance(first, SQLITE_IDLE_HANDLE_TTL_MS - 1, true);
    advance(first, 1, false);
    const next = acquirePath();
    expect(next).not.toBe(first);
    expect(opens()).toBe(2);
    cache.closeOpenClawStateDatabaseByPath(pathname);
    expect(next.db.isOpen).toBe(false);
    expect(acquirePath().db.isOpen).toBe(true);
    expect(opens()).toBe(3);
  },
);

it.each([
  { pin: "reader", ending: "release" },
  { pin: "retention", ending: "release" },
  { pin: "retention", ending: "explicit close" },
  { pin: "writer", ending: "release" },
  { pin: "writer", ending: "scope close" },
] as const)("keeps idle custody through $pin until $ending", async ({ pin, ending }) => {
  const { pathname, open } = fixture();
  const scope = createOpenClawDatabaseMaintenanceScope();
  const database = pin === "writer" ? scope.run(open) : open();
  const held =
    pin === "writer"
      ? scope.run(() => retainOpenClawStateDatabase(database))
      : pin === "reader"
        ? borrowOpenClawStateDatabaseForAsyncRead(pathname)!
        : { release: retainOpenClawStateDatabaseForIdle(database) };
  const release = () => held.release();
  try {
    if (ending === "explicit close") {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      cache.closeOpenClawStateDatabaseByPath(pathname);
      expect(database.db.isOpen).toBe(false);
    } else {
      await database.walMaintenance.stop();
      if (pin === "writer") {
        const reader = retainOpenClawStateDatabaseForIndependentRead(pathname)!;
        using _ = { [Symbol.dispose]: () => reader.release() };
        reader.observe();
      }
      advance(database, SQLITE_IDLE_HANDLE_TTL_MS + 100, true);
    }
    expect(vi.getTimerCount()).toBe(0);
    if (ending === "scope close") {
      await scope.close();
    } else {
      release();
    }
    if (ending !== "explicit close") {
      advance(database, SQLITE_IDLE_HANDLE_TTL_MS - 1, true);
      advance(database, 1, false);
    }
    release();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
    await scope.close();
  }
});

it("defers idle close while a native transaction is active", () => {
  const database = fixture().open();
  database.db.exec("BEGIN");
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(database.db).toMatchObject({ isOpen: true, isTransaction: true });
  database.db.exec("ROLLBACK");
  advance(database, SQLITE_IDLE_HANDLE_TTL_MS, false);
});

it.each(["native", "maintenance"] as const)(
  "retries retained %s idle cleanup without retiring a replacement handle",
  (failure) => {
    const { pathname, open } = fixture();
    const database = open();
    borrowOpenClawStateDatabaseForAsyncRead(pathname)?.release();
    const close =
      failure === "native"
        ? vi.spyOn(database.db, "close")
        : vi.spyOn(database.walMaintenance, "close");
    close.mockImplementationOnce(() => {
      throw new Error("synthetic idle close failure");
    });
    advance(database, SQLITE_IDLE_HANDLE_TTL_MS, failure === "native");
    expect(close).toHaveBeenCalledTimes(1);
    expect(cache.getOpenClawStateDatabaseIfOpenAtPath(pathname)).toBeUndefined();

    const replacement = open();
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(open()).toBe(replacement);
    advance(database, 1, false);
    expect(close).toHaveBeenCalledTimes(2);
    expect(replacement.db.isOpen).toBe(true);
  },
);
