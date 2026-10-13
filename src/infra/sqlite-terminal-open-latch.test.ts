import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { readStableSqliteFileGeneration } from "./sqlite-file-generation.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import { createSqliteTerminalOpenLatch } from "./sqlite-terminal-open-latch.js";

describe("terminal failure asynchronous generation validation", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

  function fixture() {
    const pathname = path.join(tempDirs.make("sqlite-terminal-open-latch-"), "state.sqlite");
    fs.writeFileSync(pathname, "generation fixture");
    const generation = readStableSqliteFileGeneration(pathname);
    const latch = createSqliteTerminalOpenLatch({ closeByPath: () => {} });
    const failure = new Error("recorded failure");
    expect(latch.record(pathname, failure, generation)).toBe(true);
    return { pathname, generation, latch, failure };
  }

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "preserves a reopened writer's locks until terminal failure disposal",
    () => {
      const pathname = path.join(tempDirs.make("sqlite-terminal-locks-"), "agent.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const seed = new DatabaseSync(pathname);
      seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE entry(value); INSERT INTO entry VALUES (1)");
      seed.close();
      const generation = readStableSqliteFileGeneration(pathname);
      const writer = new DatabaseSync(pathname);
      try {
        writer.exec("BEGIN");
        expect(writer.prepare("SELECT value FROM entry").get()?.value).toBe(1);
        const locks = readMainDatabasePosixLocks(pathname);
        expect(locks).toEqual([{ length: 510, pid: process.pid, start: 1073741826, type: "read" }]);
        const dispose = vi.fn(() => {
          expect(readMainDatabasePosixLocks(pathname)).toEqual(locks);
          writer.close();
        });
        const latch = createSqliteTerminalOpenLatch({ closeByPath: dispose });
        expect(latch.record(pathname, new Error("confirmed damage"), generation)).toBe(true);
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        if (writer.isOpen) {
          writer.close();
        }
      }
    },
  );

  it("does not return a cleared failure after pending inspection completes", async () => {
    const { pathname, latch } = fixture();
    const inspection = createDeferred<boolean>();
    const pending = latch.getAsync(pathname, () => inspection.promise);
    latch.clear(pathname);
    inspection.resolve(true);
    expect(await pending).toBeUndefined();
  });

  it.each([true, false])(
    "retains a newer failure after an older inspection reports current=%s",
    async (current) => {
      const { pathname, generation, latch } = fixture();
      const inspection = createDeferred<boolean>();
      const inspect = vi.fn(async () => true).mockImplementationOnce(() => inspection.promise);
      const pending = latch.getAsync(pathname, inspect);
      const replacement = new Error("newer failure");
      expect(latch.record(pathname, replacement, generation)).toBe(true);
      inspection.resolve(current);
      expect(await pending).toBe(replacement);
      expect(latch.get(pathname)).toBe(replacement);
      expect(inspect).toHaveBeenCalledTimes(2);
    },
  );

  it("clears only the inspected generation when it no longer matches", async () => {
    const { pathname, latch } = fixture();
    expect(await latch.getAsync(pathname, async () => false)).toBeUndefined();
    expect(latch.get(pathname)).toBeUndefined();
  });

  it("retains a known failure when the inspection transport rejects", async () => {
    const { pathname, latch, failure } = fixture();
    const unavailable = new Error("inspection unavailable");
    await expect(
      latch.getAsync(pathname, async () => {
        throw unavailable;
      }),
    ).rejects.toBe(unavailable);
    expect(latch.get(pathname)).toBe(failure);
  });
});
