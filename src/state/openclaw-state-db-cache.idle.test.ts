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

it.each(["reader", "retention"] as const)("suspends idle timers until %s release", async (kind) => {
  const pathname = path.join(tempDirs.make("shared-idle-pin-"), "state.sqlite");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const database = openOpenClawStateDatabase({ path: pathname });
  // WAL maintenance owns a separate periodic timer while the connection is open.
  await database.walMaintenance.stop();
  const borrow = kind === "reader" ? borrowOpenClawStateDatabaseForAsyncRead(pathname) : undefined;
  const release =
    kind === "reader" ? () => borrow!.release() : retainOpenClawStateDatabaseForIdle(database);
  try {
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS + 100);
    expect(database.db.isOpen).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
  }
  vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
  expect(database.db.isOpen).toBe(true);
  vi.advanceTimersByTime(1);
  expect(database.db.isOpen).toBe(false);
  release();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["release", "scope close"] as const)(
  "restarts idleness after a transferred maintenance borrow ends through %s",
  async (ending) => {
    const pathname = path.join(tempDirs.make("shared-idle-transfer-"), "state.sqlite");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const scope = createOpenClawDatabaseMaintenanceScope();
    const { database, writer } = scope.run(() => {
      const opened = openOpenClawStateDatabase({ path: pathname });
      return { database: opened, writer: retainOpenClawStateDatabase(opened) };
    });
    try {
      await database.walMaintenance.stop();
      const reader = retainOpenClawStateDatabaseForIndependentRead(pathname)!;
      try {
        reader.observe();
      } finally {
        reader.release();
      }
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(database.db.isOpen).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      if (ending === "release") {
        writer.release();
      } else {
        await scope.close();
      }
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(database.db.isOpen).toBe(true);
      vi.advanceTimersByTime(1);
      expect(database.db.isOpen).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      writer.release();
      await scope.close();
    }
  },
);

it("clears idle timers on explicit close without rearming on a late pin release", () => {
  const pathname = path.join(tempDirs.make("shared-idle-close-"), "state.sqlite");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const database = openOpenClawStateDatabase({ path: pathname });
  const release = retainOpenClawStateDatabaseForIdle(database);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  cache.closeOpenClawStateDatabaseByPath(pathname);
  expect(database.db.isOpen).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  release();
  expect(vi.getTimerCount()).toBe(0);
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
