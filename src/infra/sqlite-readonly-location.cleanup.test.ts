import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  registerSignalExitBarrier,
  waitForSignalExitBarriers,
} from "../cli/signal-exit-barrier.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  adoptPreparedLocation,
  cleanupSnapshotOperations,
} from "./sqlite-readonly-location-cleanup.js";
import { prepareSingleFlightSqliteSnapshot } from "./sqlite-snapshot-single-flight.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });
});

function fixture(strict: boolean) {
  const parent = tempDirs.make("sqlite-cleanup-owner-");
  const ownedRoot = path.join(parent, "owned");
  const child = path.join(ownedRoot, "snapshot-child");
  fs.mkdirSync(child, { recursive: true });
  const location = path.join(child, "database.sqlite");
  const sibling = path.join(parent, "retained.txt");
  fs.writeFileSync(location, "private synthetic snapshot");
  fs.writeFileSync(sibling, "not owned by snapshot");
  return { ownedRoot, sibling, prepared: adoptPreparedLocation(location, ownedRoot, strict) };
}

describe("prepared SQLite snapshot cleanup", () => {
  it.each([false, true])(
    "retains cancelled orphan cleanup for retry (strict: %s)",
    async (strict) => {
      const { ownedRoot, sibling, prepared } = fixture(strict);
      const produced = createDeferredCore();
      const tracked: Promise<unknown>[] = [];
      const controller = new AbortController();
      const pending = prepareSingleFlightSqliteSnapshot(
        path.join(ownedRoot, "source.sqlite"),
        "orphan-retry",
        async () => {
          await produced.promise;
          return prepared;
        },
        controller.signal,
        { trackProducer: (producer) => tracked.push(producer) },
      );
      controller.abort(new Error("cancelled before publication"));
      await expect(pending).rejects.toThrow("cancelled before publication");
      const remove = fs.promises.rm;
      const failedRemoval = vi
        .spyOn(fs.promises, "rm")
        .mockImplementation(async (target, options) => {
          if (String(target) === ownedRoot) {
            throw Object.assign(new Error("snapshot busy"), { code: "EBUSY" });
          }
          return remove(target, options);
        });
      try {
        produced.resolve();
        await expect(tracked[0]).rejects.toThrow(/cleanup/);
        expect(fs.existsSync(prepared.location)).toBe(true);
      } finally {
        failedRemoval.mockRestore();
        await cleanupSnapshotOperations();
      }
      expect(fs.existsSync(ownedRoot)).toBe(false);
      expect(fs.readFileSync(sibling, "utf8")).toBe("not owned by snapshot");
    },
  );
  it.each([false, true])(
    "retains all snapshot tokens when data removal fails (async: %s)",
    async (asynchronous) => {
      const { ownedRoot, prepared } = fixture(false);
      const location = path.join(ownedRoot, "snapshot-child/database.sqlite");
      const tokens = [ownedRoot, path.dirname(location)].map((directory) =>
        path.join(directory, "owner.sqlite"),
      );
      for (const token of tokens) {
        fs.writeFileSync(token, "");
      }
      const remove = fs.rmSync;
      const failDataRemoval: typeof fs.rmSync = (target, options) => {
        if (String(target) === ownedRoot) {
          // A recursive rm may unlink metadata before reaching a busy data file.
          for (const token of tokens) {
            remove(token, { force: true });
          }
        }
        if (String(target) === ownedRoot || String(target) === location) {
          throw Object.assign(new Error("snapshot data still open"), { code: "EBUSY" });
        }
        remove(target, options);
      };
      const stub = asynchronous
        ? vi
            .spyOn(fs.promises, "rm")
            .mockImplementation(async (target, options) => failDataRemoval(target, options))
        : vi.spyOn(fs, "rmSync").mockImplementation(failDataRemoval);
      try {
        expect(asynchronous ? await prepared.cleanupAsync() : prepared.cleanup()).toBe(false);
        expect(fs.existsSync(location)).toBe(true);
        expect(tokens.every((token) => fs.existsSync(token))).toBe(true);
      } finally {
        stub.mockRestore();
      }
      expect(await prepared.cleanupAsync()).toBe(true);
      expect(fs.existsSync(ownedRoot)).toBe(false);
    },
  );

  it("keeps the private read view until other shutdown owners have drained", async () => {
    const { ownedRoot } = fixture(false);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const unregister = registerSignalExitBarrier(async () => {
      entered.resolve();
      await release.promise;
      expect(fs.readFileSync(path.join(ownedRoot, "snapshot-child/database.sqlite"), "utf8")).toBe(
        "private synthetic snapshot",
      );
    });
    const removal = vi.spyOn(fs.promises, "rm");
    const shutdown = waitForSignalExitBarriers();
    try {
      await entered.promise;
      expect(removal).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      try {
        await shutdown;
      } finally {
        unregister();
      }
    }
    expect(fs.existsSync(ownedRoot)).toBe(false);
  });

  it.each([false, true])(
    "joins concurrent async removal and refuses racing synchronous cleanup (strict: %s)",
    async (strict) => {
      const { ownedRoot, sibling, prepared } = fixture(strict);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const remove = fs.promises.rm;
      const removal = vi.spyOn(fs.promises, "rm").mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        await remove(...args);
      });
      const synchronousRemoval = vi.spyOn(fs, "rmSync");
      const first = prepared.cleanupAsync();
      const second = prepared.cleanupAsync();
      let settled = false;
      void first.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await entered.promise;
        expect(settled).toBe(false);
        expect(fs.existsSync(ownedRoot)).toBe(true);
        if (strict) {
          expect(() => prepared.cleanup()).toThrow("snapshot cleanup failed");
        } else {
          expect(prepared.cleanup()).toBe(false);
        }
        expect(synchronousRemoval).not.toHaveBeenCalled();
        expect(removal).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
      }
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(fs.existsSync(ownedRoot)).toBe(false);
      expect(fs.readFileSync(sibling, "utf8")).toBe("not owned by snapshot");
      expect(prepared.cleanup()).toBe(true);
      expect(await prepared.cleanupAsync()).toBe(true);
      expect(removal).toHaveBeenCalledOnce();
      expect(synchronousRemoval).not.toHaveBeenCalled();
    },
  );

  it.each([
    { strict: false, retry: "sync" },
    { strict: true, retry: "async" },
  ] as const)(
    "keeps failed async removal retryable with $retry cleanup (strict: $strict)",
    async ({ strict, retry }) => {
      const { ownedRoot, prepared } = fixture(strict);
      const failure = Object.assign(new Error("snapshot busy"), { code: "EBUSY" });
      const remove = vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(failure);
      const first = prepared.cleanupAsync();
      if (strict) {
        await expect(first).rejects.toThrow("snapshot cleanup failed");
      } else {
        expect(await first).toBe(false);
      }
      expect(fs.existsSync(ownedRoot)).toBe(true);
      expect(retry === "async" ? await prepared.cleanupAsync() : prepared.cleanup()).toBe(true);
      expect(fs.existsSync(ownedRoot)).toBe(false);
      expect(remove).toHaveBeenCalledTimes(retry === "async" ? 2 : 1);
      expect(await prepared.cleanupAsync()).toBe(true);
    },
  );
});
