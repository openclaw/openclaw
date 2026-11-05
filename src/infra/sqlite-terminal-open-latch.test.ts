import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import { createSqliteTerminalOpenLatch } from "./sqlite-terminal-open-latch.js";

describe("terminal failure disposal", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

  it("releases caller data while retaining the terminal error", async ({ signal }) => {
    const result = await runNodeScript(
      [
        "--expose-gc",
        "--import",
        fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
        fileURLToPath(
          new URL("../../scripts/perf/long-lived-error-stacks-measure.ts", import.meta.url),
        ),
        "--owner=sqlite-latch",
        "--mode=heap",
        "--records=3",
        "--assert-collected",
      ],
      { ...process.env, NODE_OPTIONS: "" },
      undefined,
      { signal, maxBuffer: 64 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).retainedFixtures).toBe(0);
  });

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
