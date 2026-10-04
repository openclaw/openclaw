import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  cleanupSnapshotOperations,
  registerRetainedSnapshotTempDirectory,
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
      registerRetainedSnapshotTempDirectory(directory, () => {
        const cleanup = createRetainedOperation<void>(() => {});
        void mocks
          .retire()
          .then(async () => {
            await fs.promises.rm(directory, { recursive: true, force: true });
          })
          .then(() => cleanup.resolve(), cleanup.reject);
        return cleanup.operation;
      });
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

it.each(["sync", "async"] as const)(
  "joins %s cleanup before releasing private bytes",
  async (mode) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    if (mode === "async") {
      mocks.retire.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
    }
    if (mode === "sync") {
      const prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(database, () => {});
      expect(mocks.backup.mock.calls[0]?.[0]).toBe(database);
      expect(prepared.cleanup()).toBe(true);
      expect(mocks.retireSync).toHaveBeenCalledOnce();
      expect(mocks.retire).not.toHaveBeenCalled();
    } else {
      const prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(
        database,
        () => {},
        undefined,
        mode,
      );
      let finished = false;
      const closing = prepared.cleanupAsync().then((removed) => {
        finished = true;
        return removed;
      });
      try {
        await Promise.race([entered.promise, closing]);
        expect(mocks.retire).toHaveBeenCalledOnce();
        expect(finished).toBe(false);
        expect(fs.existsSync(prepared.location)).toBe(true);
        expect(database.isOpen).toBe(true);
      } finally {
        release.resolve();
        await closing;
      }
      expect(mocks.retireSync).not.toHaveBeenCalled();
    }
    expect(fs.existsSync(directory)).toBe(false);
    expect(database.isOpen).toBe(true);
  },
);

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
  expect(failure).toMatchObject({
    message: expect.stringContaining("native backup failed"),
    errors: [original, cleanup],
    cause: original,
  });
  expect(fs.existsSync(directory)).toBe(true);
  expect(database.isOpen).toBe(true);
  await cleanupSnapshotOperations();
  expect(fs.existsSync(directory)).toBe(false);
  expect(mocks.retire).toHaveBeenCalledTimes(2);
});

it.each(["allocation", "backup", "cancelled allocation"] as const)(
  "joins %s before rejecting lost authority without publishing",
  async (phase) => {
    const failure = new Error(
      phase === "cancelled allocation" ? "native inspection cancelled" : "source owner replaced",
    );
    const controller = new AbortController();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw failure;
      }
    };
    if (phase === "backup") {
      const backup = mocks.backup.getMockImplementation()!;
      mocks.backup.mockImplementation(async (...args) => {
        const result = await backup(...args);
        current = false;
        return result;
      });
    } else {
      const allocate = mocks.allocate.getMockImplementation()!;
      mocks.allocate.mockImplementation(async (...args) => {
        if (phase === "cancelled allocation") {
          entered.resolve();
          await release.promise;
        }
        const result = await allocate(...args);
        if (phase === "allocation") {
          current = false;
        }
        return result;
      });
    }
    const result = prepareSqliteReadOnlyLocationFromOwnedDatabase(
      database,
      assertCurrent,
      controller.signal,
      "async",
    );
    const rejected = expect(result).rejects.toBe(failure);
    try {
      if (phase === "cancelled allocation") {
        await entered.promise;
        controller.abort(failure);
        expect(mocks.backup).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      await rejected;
    }
    expect(mocks.backup).toHaveBeenCalledTimes(phase === "backup" ? 1 : 0);
    expect(fs.existsSync(directory)).toBe(false);
    expect(database.isOpen).toBe(true);
  },
);
