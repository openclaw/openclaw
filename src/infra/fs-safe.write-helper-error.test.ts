import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const tempDirs = createTrackedTempDirs();

describe("fs-safe write helper errors", () => {
  let writeFileWithinRoot: typeof import("./fs-safe.js").writeFileWithinRoot;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./fs-pinned-write-helper.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./fs-pinned-write-helper.js")>();
      return {
        ...actual,
        runPinnedWriteHelper: async () => {
          throw new Error("Pinned write helper failed to start: spawn python3 ENOENT");
        },
      };
    });
    ({ writeFileWithinRoot } = await import("./fs-safe.js"));
  });

  afterEach(async () => {
    await tempDirs.cleanup();
    vi.doUnmock("./fs-pinned-write-helper.js");
    vi.resetModules();
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the write helper cannot start",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const targetPath = path.join(root, "note.txt");

      await expect(
        writeFileWithinRoot({
          rootDir: root,
          relativePath: "note.txt",
          data: "hello",
        }),
      ).rejects.toThrow(/failed to start: spawn python3 ENOENT/i);

      await expect(fs.readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
