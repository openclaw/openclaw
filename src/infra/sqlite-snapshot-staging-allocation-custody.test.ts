import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  cleanupSnapshotOperations,
  removeTempDirectoryAsync,
  retainSnapshotTempDirectory,
} from "./sqlite-readonly-location-cleanup.js";
import { allocateWorkerOwnedSqliteSnapshotDirectory } from "./sqlite-snapshot-staging-allocation.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import { holdAllocatedReply } from "./sqlite-snapshot-staging.test-support.js";
import type { SqliteSnapshotStagingRequest } from "./sqlite-snapshot-staging.types.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupSnapshotOperations();
    cleanup();
  });
});

it.each([false, true])(
  "settles lost allocation delivery only after original cleanup or its independent failure (readerHeld=%s)",
  async (readerHeld) => {
    const root = directories.make("staging-allocation-custody-");
    const owner = captureSqliteSnapshotStagingOwner();
    const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
    const create = source.create.bind(source);
    const allocated = createDeferredCore<{ native: RetainedNativeWorker; directory: string }>();
    let capturedAllocation = false;
    const creation = vi.spyOn(source, "create").mockImplementation((...args) => {
      const native = create(...args);
      holdAllocatedReply(native, (directory) => {
        if (capturedAllocation) {
          return false;
        }
        capturedAllocation = true;
        allocated.resolve({ native, directory });
        return true;
      });
      return native;
    });
    const start = owner.start.bind(owner);
    const captured: {
      request?: SqliteSnapshotStagingRequest;
      failure?: { error: unknown };
    } = {};
    const admission = vi.spyOn(owner, "start").mockImplementation((...args) => {
      const accepted = start(...args);
      if (!captured.request) {
        captured.request = accepted;
        void accepted.result.catch((error: unknown) => {
          captured.failure = { error };
        });
      }
      return accepted;
    });
    let directory: string | undefined;
    let native: RetainedNativeWorker | undefined;
    let nativeJoined = false;
    let releaseReader: (() => void) | undefined;
    let stopping: Promise<void> | undefined;
    let next: Awaited<ReturnType<typeof allocateWorkerOwnedSqliteSnapshotDirectory>> | undefined;
    const pending = allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
    const outcome = pending.then(
      () => {
        throw new Error("Lost allocation delivery unexpectedly published a directory");
      },
      (error: unknown) => ({
        error,
        directoryExists: directory !== undefined && fs.existsSync(directory),
        nativeJoined,
      }),
    );
    void outcome.catch(() => undefined);
    try {
      const held = await Promise.race([
        allocated.promise,
        pending.then(() => {
          throw new Error("Allocation settled before its real reply was held");
        }),
      ]);
      ({ native, directory } = held);
      creation.mockRestore();
      admission.mockRestore();
      expect(fs.existsSync(directory)).toBe(true);
      const sqlite = requireNodeSqlite();
      const tokenPath = path.join(directory, "owner.sqlite");
      const assertCreatorHeld = () => {
        const token = new sqlite.DatabaseSync(tokenPath, { timeout: 0 });
        try {
          expect(() => token.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
        } finally {
          if (token.isTransaction) {
            token.exec("ROLLBACK");
          }
          token.close();
        }
      };
      assertCreatorHeld();
      if (readerHeld) {
        releaseReader = retainSnapshotTempDirectory(directory);
      }
      native.once("exit", () => {
        nativeJoined = true;
      });
      // Kill the actual VM while only its real allocated reply is held back.
      stopping = native.stop().result;
      void stopping.catch(() => undefined);
      const rejected = await outcome;
      expect(captured.failure).toBeDefined();
      expect(native.executionStopped).toBe(true);
      if (readerHeld) {
        expect(rejected.error).toBeInstanceOf(AggregateError);
        if (!(rejected.error instanceof AggregateError)) {
          throw new Error("Allocation and cleanup failures must both remain observable");
        }
        expect(rejected.error.errors).toContain(captured.failure?.error);
        expect(rejected.error.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              errors: expect.arrayContaining([
                expect.objectContaining({
                  message: "SQLite snapshot still belongs to an active reader",
                }),
              ]),
            }),
          ]),
        );
        expect(rejected.directoryExists).toBe(true);
        expect(rejected.nativeJoined).toBe(false);
        assertCreatorHeld();
        releaseReader?.();
        releaseReader = undefined;
        if (!captured.request) {
          throw new Error("Original allocation request was not captured");
        }
        await captured.request.startClose().result;
      } else {
        expect(rejected.error).toBe(captured.failure?.error);
        expect(rejected.directoryExists).toBe(false);
        expect(rejected.nativeJoined).toBe(true);
      }
      expect(fs.existsSync(directory)).toBe(false);
      expect(nativeJoined).toBe(true);
      next = await allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
      expect(fs.existsSync(next.directory)).toBe(true);
      expect(await removeTempDirectoryAsync(next.directory)).toBe(true);
      next = undefined;
    } finally {
      creation.mockRestore();
      admission.mockRestore();
      releaseReader?.();
      if (captured.request) {
        await captured.request.startClose().result;
      }
      await Promise.allSettled([pending, stopping, outcome]);
      if (directory) {
        expect(fs.existsSync(directory)).toBe(false);
      }
      if (native) {
        await native.stop().result;
      }
      if (next) {
        expect(await removeTempDirectoryAsync(next.directory)).toBe(true);
      }
    }
    expect(fs.readdirSync(root)).toEqual([]);
  },
);
