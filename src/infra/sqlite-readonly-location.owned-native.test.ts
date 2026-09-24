import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  cleanupSnapshotOperations,
  registerAsyncSnapshotTempDirectory,
  registerSnapshotTempDirectory,
} from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationFromOwnedDatabase } from "./sqlite-readonly-location.js";
import type { SqliteStagingToken } from "./sqlite-staging-token.js";

const mocks = vi.hoisted(() => ({
  allocate:
    vi.fn<typeof import("./sqlite-snapshot-staging.js").createSqliteSnapshotStagingDirectory>(),
  backup: vi.fn<typeof import("./sqlite-backup.js").backupNodeSqliteDatabase>(),
  retire: vi.fn<() => Promise<void>>(),
  retireSync: vi.fn<() => void>(),
}));
const synchronousToken: SqliteStagingToken = Object.assign(mocks.retireSync, {
  beginRetirement: () => synchronousToken,
});
vi.mock("./sqlite-backup.js", () => ({ backupNodeSqliteDatabase: mocks.backup }));
vi.mock("./sqlite-snapshot-staging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-snapshot-staging.js")>()),
  createSqliteSnapshotStagingDirectory: mocks.allocate,
}));

let database: DatabaseSync;
let directory: string;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    mocks.retire.mockResolvedValue();
    mocks.retireSync.mockImplementation(() => {});
    await cleanupSnapshotOperations();
    if (database.isOpen) {
      database.close();
    }
    vi.restoreAllMocks();
    cleanup();
  }),
);
beforeEach(() => {
  directory = path.join(tempDirs.make("owned-native-snapshot-"), "copy");
  database = new (requireNodeSqlite().DatabaseSync)(":memory:");
  mocks.retire.mockReset().mockResolvedValue();
  mocks.retireSync.mockReset();
  mocks.allocate.mockReset().mockImplementation(async (_root, _legacy, _signal, asynchronous) => {
    fs.mkdirSync(directory);
    if (asynchronous) {
      registerAsyncSnapshotTempDirectory(directory, mocks.retire);
    } else {
      registerSnapshotTempDirectory(directory, synchronousToken);
    }
    return directory;
  });
  mocks.backup.mockReset().mockImplementation(async (_source, target) => {
    fs.writeFileSync(target, "private backup fixture; never opened as SQLite");
    return 1;
  });
});

it("keeps the existing default snapshot cleanup synchronous", async () => {
  const prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(database, () => {});
  expect(mocks.backup.mock.calls[0]?.[0]).toBe(database);
  expect(prepared.cleanup()).toBe(true);
  expect(mocks.retireSync).toHaveBeenCalledOnce();
  expect(mocks.retire).not.toHaveBeenCalled();
  expect(fs.existsSync(directory)).toBe(false);
  expect(database.isOpen).toBe(true);
});

it("joins asynchronous token retirement before removing the published private bytes", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  mocks.retire.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  const prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(
    database,
    () => {},
    undefined,
    "async",
  );
  let finished = false;
  const closing = prepared.cleanupAsync().then((removed) => {
    finished = true;
    return removed;
  });
  try {
    // The original synchronous path never invokes the asynchronous retirement owner.
    await Promise.race([entered.promise, closing]);
    expect(mocks.retire).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    expect(fs.existsSync(prepared.location)).toBe(true);
    expect(database.isOpen).toBe(true);
  } finally {
    release.resolve();
    await closing;
  }
  expect(fs.existsSync(directory)).toBe(false);
  expect(mocks.retireSync).not.toHaveBeenCalled();
});

it("retains original and unpublished cleanup failures until the snapshot registry retries", async () => {
  const original = new Error("native backup failed");
  const cleanup = new Error("token retirement failed");
  mocks.backup.mockRejectedValue(original);
  mocks.retire.mockRejectedValueOnce(cleanup);
  mocks.retireSync.mockImplementationOnce(() => {
    throw cleanup;
  });
  const failure = await prepareSqliteReadOnlyLocationFromOwnedDatabase(
    database,
    () => {},
    undefined,
    "async",
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ errors: [original, cleanup], cause: original });
  expect(fs.existsSync(directory)).toBe(true);
  expect(database.isOpen).toBe(true);
  await cleanupSnapshotOperations();
  expect(fs.existsSync(directory)).toBe(false);
  expect(mocks.retire).toHaveBeenCalledTimes(2);
});

it.each(["allocation", "backup"] as const)(
  "rechecks captured authority after %s and cleans without publishing",
  async (phase) => {
    const failure = new Error("source owner replaced");
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw failure;
      }
    };
    if (phase === "allocation") {
      const allocate = mocks.allocate.getMockImplementation()!;
      mocks.allocate.mockImplementation(async (...args) => {
        const result = await allocate(...args);
        current = false;
        return result;
      });
    } else {
      const backup = mocks.backup.getMockImplementation()!;
      mocks.backup.mockImplementation(async (...args) => {
        const result = await backup(...args);
        current = false;
        return result;
      });
    }
    await expect(
      prepareSqliteReadOnlyLocationFromOwnedDatabase(database, assertCurrent, undefined, "async"),
    ).rejects.toBe(failure);
    expect(mocks.backup).toHaveBeenCalledTimes(phase === "allocation" ? 0 : 1);
    expect(fs.existsSync(directory)).toBe(false);
    expect(database.isOpen).toBe(true);
  },
);

it("joins accepted allocation before cleaning a cancelled native snapshot", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const allocate = mocks.allocate.getMockImplementation()!;
  mocks.allocate.mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return allocate(...args);
  });
  const controller = new AbortController();
  const reason = new Error("native inspection cancelled");
  const result = prepareSqliteReadOnlyLocationFromOwnedDatabase(
    database,
    () => {},
    controller.signal,
    "async",
  );
  const outcome = result.catch((error: unknown) => error);
  await entered.promise;
  controller.abort(reason);
  expect(mocks.backup).not.toHaveBeenCalled();
  release.resolve();
  expect(await outcome).toBe(reason);
  expect(mocks.backup).not.toHaveBeenCalled();
  expect(fs.existsSync(directory)).toBe(false);
  expect(database.isOpen).toBe(true);
});
