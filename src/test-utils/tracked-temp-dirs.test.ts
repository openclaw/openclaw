import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTrackedTempDirs } from "./tracked-temp-dirs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("removes every allocated directory and supports reuse without retaining prefix roots", async () => {
  const sandbox = tempDirs.make("openclaw-tracked-temp-dirs-");
  const prefix = path.join(path.basename(sandbox), "fixture-");
  const tracked = createTrackedTempDirs();
  const dirs = await Promise.all([tracked.make(prefix), tracked.make(prefix)]);
  try {
    expect(new Set(dirs).size).toBe(2);
    await Promise.all(dirs.map((dir) => fs.writeFile(path.join(dir, "marker"), dir)));
    for (const dir of dirs) {
      expect(await fs.readFile(path.join(dir, "marker"), "utf8")).toBe(dir);
      if (process.platform !== "win32") {
        expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      }
    }
    await tracked.cleanup();
    expect(await fs.readdir(sandbox)).toEqual([]);

    const pending = tracked.make(prefix);
    await tracked.cleanup();
    await pending;
    expect(await fs.readdir(sandbox)).toEqual([]);
  } finally {
    await tracked.cleanup();
  }
});
