import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const tempDirs = createTrackedTempDirs();

describe("fs-safe unlink helper errors", () => {
  let removeFileWithinRoot: typeof import("./fs-safe.js").removeFileWithinRoot;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./fs-pinned-write-helper.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./fs-pinned-write-helper.js")>();
      return {
        ...actual,
        runPinnedUnlinkHelper: async () => {
          throw new Error("Pinned unlink helper failed to start: spawn python3 ENOENT");
        },
      };
    });
    ({ removeFileWithinRoot } = await import("./fs-safe.js"));
  });

  afterEach(async () => {
    await tempDirs.cleanup();
    vi.doUnmock("./fs-pinned-write-helper.js");
    vi.resetModules();
  });

  it.runIf(process.platform !== "win32")(
    "falls back to the legacy rooted delete when the unlink helper cannot start",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const targetPath = path.join(root, "note.txt");
      await fs.writeFile(targetPath, "hello", "utf8");

      await removeFileWithinRoot({
        rootDir: root,
        relativePath: "note.txt",
      });

      await expect(fs.readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
