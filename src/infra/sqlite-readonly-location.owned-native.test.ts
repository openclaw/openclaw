import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  cleanupSnapshotOperations,
  registerRetainedSnapshotTempDirectory,
  registerSnapshotTempDirectory,
} from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationFromOwnedDatabase } from "./sqlite-readonly-location.js";
import { createReadBarrier, observeSettlement } from "./sqlite-readonly.test-support.js";
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
let owner: {
  current: boolean;
  lostAt?: "allocation" | "backup";
  beforeAllocation?: () => Promise<void>;
};
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
  owner = { current: true };
  directory = path.join(tempDirs.make("owned-native-snapshot-"), "copy");
  database = new (requireNodeSqlite().DatabaseSync)(":memory:");
  mocks.retire.mockReset().mockResolvedValue();
  mocks.retireSync.mockReset();
  mocks.allocate.mockReset().mockImplementation(async (_root, _legacy, _signal, asynchronous) => {
    if (owner.beforeAllocation) {
      await owner.beforeAllocation();
    }
    fs.mkdirSync(directory);
    if (asynchronous) {
      registerRetainedSnapshotTempDirectory(directory, () => {
        const cleanup = createRetainedOperation<void>(() => {});
        void mocks
          .retire()
          .then(() => fs.promises.rm(directory, { recursive: true, force: true }))
          .then(() => cleanup.resolve(), cleanup.reject);
        return cleanup.operation;
      });
    } else {
      registerSnapshotTempDirectory(directory, synchronousToken);
    }
    if (owner.lostAt === "allocation") {
      owner.current = false;
    }
    return directory;
  });
  mocks.backup.mockReset().mockImplementation(async (_source, target) => {
    fs.writeFileSync(target, "backup");
    if (owner.lostAt === "backup") {
      owner.current = false;
    }
    return 1;
  });
});

function prepare(assertCurrent = () => {}, signal?: AbortSignal) {
  return prepareSqliteReadOnlyLocationFromOwnedDatabase(database, assertCurrent, signal, "async");
}

function expectOwnership(exists: boolean) {
  expect([fs.existsSync(directory), database.isOpen]).toEqual([exists, true]);
}

it("joins sync cleanup before releasing private bytes", async () => {
  const prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(database, () => {});
  expect(mocks.backup.mock.calls[0]?.[0]).toBe(database);
  expect(prepared.cleanup()).toBe(true);
  expect(mocks.retireSync).toHaveBeenCalledOnce();
  expect(mocks.retire).not.toHaveBeenCalled();
  expectOwnership(false);
});

it("joins async cleanup before releasing private bytes", async () => {
  const { entered, resume, hold } = createReadBarrier();
  mocks.retire.mockImplementation(() => hold(undefined));
  const prepared = await prepare();
  const closing = prepared.cleanupAsync();
  const observation = observeSettlement(closing);
  try {
    await Promise.race([entered.promise, closing]);
    expect(mocks.retire).toHaveBeenCalledOnce();
    expect(observation.settled).toBe(false);
    expect([fs.existsSync(prepared.location), database.isOpen]).toEqual([true, true]);
  } finally {
    resume.resolve();
    await closing;
  }
  expect(mocks.retireSync).not.toHaveBeenCalled();
  expectOwnership(false);
});

it("retains original and unpublished cleanup failures until the snapshot registry retries", async () => {
  const original = new Error("native backup failed");
  const cleanup = new Error("token retirement failed");
  mocks.backup.mockRejectedValue(original);
  mocks.retire.mockRejectedValueOnce(cleanup);
  mocks.retireSync.mockImplementationOnce(() => {
    throw cleanup;
  });
  const failure = await prepare().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    message: expect.stringContaining("native backup failed"),
    errors: [original, cleanup],
    cause: original,
  });
  expectOwnership(true);
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
    const { entered, resume, hold } = createReadBarrier();
    owner.lostAt = phase === "cancelled allocation" ? undefined : phase;
    owner.beforeAllocation = phase === "cancelled allocation" ? () => hold(undefined) : undefined;
    const result = prepare(() => {
      if (!owner.current) {
        throw failure;
      }
    }, controller.signal);
    const rejected = expect(result).rejects.toBe(failure);
    try {
      if (phase === "cancelled allocation") {
        await entered.promise;
        controller.abort(failure);
        expect(mocks.backup).not.toHaveBeenCalled();
      }
    } finally {
      resume.resolve();
      await rejected;
    }
    expect(mocks.backup).toHaveBeenCalledTimes(phase === "backup" ? 1 : 0);
    expectOwnership(false);
  },
);
