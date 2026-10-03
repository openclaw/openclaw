import { createHash } from "node:crypto";
import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  ["async", false],
  ["async", true],
  ["sync", false],
  ["sync", true],
] as const)(
  "verifies snapshot bytes despite FUSE timestamp drift (%s, changed bytes=%s)",
  async (mode, changeBytes) => {
    const directory = directories.make("sqlite-fuse-");
    const sourcePath = path.join(directory, "source.sqlite");
    const targetPath = path.join(directory, "snapshot.bak");
    const source = new DatabaseSync(sourcePath);
    source.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('keep');");
    source.close();
    const originalOpen = fs.open.bind(fs);
    let observations = 0;
    function settleMetadata(value: BigIntStats) {
      // Model delayed metadata publication without changing the file identity.
      value.ctimeNs += BigInt(++observations) * 1_000_000_000n;
      if (changeBytes && observations === 2) {
        // The first hash has read the original bytes; retain size and inode.
        const writer = fsSync.openSync(targetPath, "r+");
        try {
          fsSync.writeSync(writer, Buffer.from("lost"), 0, 4, 100);
        } finally {
          fsSync.closeSync(writer);
        }
      }
      return value;
    }
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (mode === "async" && String(args[0]) === targetPath && args[1] === "r") {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
          if (statArgs[0]?.bigint) {
            return settleMetadata(await stat({ bigint: true }));
          }
          return await stat(...statArgs);
        });
      }
      return handle;
    });

    const operation = createVerifiedSqliteSnapshot({
      sourcePath,
      targetPath,
      afterPublish: (guard) => {
        if (mode === "sync") {
          const fstat = fsSync.fstatSync.bind(fsSync);
          vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) =>
            args[1]?.bigint ? settleMetadata(fstat(args[0], { bigint: true })) : fstat(...args),
          );
        }
        guard.assertTargetMatchesExpectedContent();
      },
    });
    if (changeBytes) {
      await expect(operation).rejects.toThrow(/hash mismatch/);
    } else {
      const result = await operation;
      const bytes = fsSync.readFileSync(targetPath);
      expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(result.sizeBytes).toBe(bytes.length);
      const snapshot = new DatabaseSync(targetPath, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT value FROM records").all()).toEqual([{ value: "keep" }]);
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        snapshot.close();
      }
    }
    expect(observations).toBeGreaterThan(1);
  },
);
