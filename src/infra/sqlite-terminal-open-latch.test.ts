import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import { createSqliteTerminalOpenLatch } from "./sqlite-terminal-open-latch.js";

describe("terminal failure disposal", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "preserves a reopened writer's locks until terminal failure disposal",
    () => {
      const pathname = path.join(tempDirs.make("sqlite-terminal-locks-"), "agent.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const seed = new DatabaseSync(pathname);
      seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE entry(value); INSERT INTO entry VALUES (1)");
      seed.close();
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
        latch.record(pathname, new Error("confirmed damage"));
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        if (writer.isOpen) {
          writer.close();
        }
      }
    },
  );
});
