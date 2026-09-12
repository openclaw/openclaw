import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readStableSqliteFileGeneration } from "./sqlite-file-generation.js";
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
