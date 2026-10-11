import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  borrowOpenClawStateDatabaseForAsyncRead,
  openClawStateDatabaseCache as cache,
  retainOpenClawStateDatabase,
  retainOpenClawStateDatabaseForIdle,
  retainOpenClawStateDatabaseForIndependentRead,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase, runWithOpenClawStateBusyTimeout } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    cache.closeOpenClawStateDatabaseForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });
});

it.each(["path", "supplied", "busy-timeout"] as const)(
  "reuses shared-state handles until 30 minutes after their last %s acquisition",
  (acquisition) => {
    const pathname = path.join(tempDirs.make("shared-idle-"), "state.sqlite");
    const fileUri = nodeSqlite.resolveExistingSqliteFileUri(pathname);
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = openOpenClawStateDatabase({ path: pathname });
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
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(first.db.isOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(first.db.isOpen).toBe(false);
    const next = openOpenClawStateDatabase({ path: pathname });
    expect(next).not.toBe(first);
    expect(opens()).toBe(2);
    cache.closeOpenClawStateDatabaseByPath(pathname);
    expect(next.db.isOpen).toBe(false);
    expect(openOpenClawStateDatabase({ path: pathname }).db.isOpen).toBe(true);
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
  const pathname = path.join(tempDirs.make("shared-idle-pin-"), "state.sqlite");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const scope = createOpenClawDatabaseMaintenanceScope();
  const open = () => openOpenClawStateDatabase({ path: pathname });
  const database = pin === "writer" ? scope.run(open) : open();
  const writer =
    pin === "writer" ? scope.run(() => retainOpenClawStateDatabase(database)) : undefined;
  const borrow = pin === "reader" ? borrowOpenClawStateDatabaseForAsyncRead(pathname)! : undefined;
  const release = writer
    ? () => writer.release()
    : pin === "reader"
      ? () => borrow!.release()
      : retainOpenClawStateDatabaseForIdle(database);
  try {
    if (ending === "explicit close") {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      cache.closeOpenClawStateDatabaseByPath(pathname);
      expect(database.db.isOpen).toBe(false);
    } else {
      await database.walMaintenance.stop();
      if (writer) {
        const reader = retainOpenClawStateDatabaseForIndependentRead(pathname)!;
        try {
          reader.observe();
        } finally {
          reader.release();
        }
      }
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS + 100);
      expect(database.db.isOpen).toBe(true);
    }
    expect(vi.getTimerCount()).toBe(0);
    if (ending === "scope close") {
      await scope.close();
    } else {
      release();
    }
    if (ending !== "explicit close") {
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(database.db.isOpen).toBe(true);
      vi.advanceTimersByTime(1);
      expect(database.db.isOpen).toBe(false);
    }
    release();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
    await scope.close();
  }
});

it("defers idle close while a native transaction is active", () => {
  const pathname = path.join(tempDirs.make("shared-idle-transaction-"), "state.sqlite");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const database = openOpenClawStateDatabase({ path: pathname });
  database.db.exec("BEGIN");
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(database.db.isOpen).toBe(true);
  expect(database.db.isTransaction).toBe(true);
  database.db.exec("ROLLBACK");
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
  expect(database.db.isOpen).toBe(false);
});

it.each(["native", "maintenance"] as const)(
  "retries retained %s idle cleanup without retiring a replacement handle",
  (failure) => {
    const pathname = path.join(tempDirs.make("shared-idle-retry-"), "state.sqlite");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const database = openOpenClawStateDatabase({ path: pathname });
    borrowOpenClawStateDatabaseForAsyncRead(pathname)?.release();
    const close =
      failure === "native"
        ? vi.spyOn(database.db, "close")
        : vi.spyOn(database.walMaintenance, "close");
    close.mockImplementationOnce(() => {
      throw new Error("synthetic idle close failure");
    });
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(database.db.isOpen).toBe(failure === "native");
    expect(close).toHaveBeenCalledTimes(1);
    expect(cache.getOpenClawStateDatabaseIfOpenAtPath(pathname)).toBeUndefined();

    const replacement = openOpenClawStateDatabase({ path: pathname });
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(openOpenClawStateDatabase({ path: pathname })).toBe(replacement);
    vi.advanceTimersByTime(1);
    expect(database.db.isOpen).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
    expect(replacement.db.isOpen).toBe(true);
  },
);
