import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { adoptPreparedLocation } from "./sqlite-readonly-location-cleanup.js";
import { readSqliteSchemaHeaderFromSnapshotAsync } from "./sqlite-schema-header.js";

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
  it("retains header cancellation and failed async removal while cleanup remains retryable", async () => {
    const { ownedRoot, prepared } = fixture(false);
    const controller = new AbortController();
    const cancelled = new Error("header owner retired before its read");
    controller.abort(cancelled);
    const removal = vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(new Error("snapshot busy"));
    const synchronousRemoval = vi.spyOn(fs, "rmSync");
    await expect(
      readSqliteSchemaHeaderFromSnapshotAsync(prepared, controller.signal),
    ).rejects.toMatchObject({
      cause: cancelled,
      errors: [
        cancelled,
        expect.objectContaining({ message: expect.stringContaining("snapshot cleanup failed") }),
      ],
    });
    expect(synchronousRemoval).not.toHaveBeenCalled();
    expect(removal).toHaveBeenCalledOnce();
    expect(fs.existsSync(ownedRoot)).toBe(true);
    expect(await prepared.cleanupAsync()).toBe(true);
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
