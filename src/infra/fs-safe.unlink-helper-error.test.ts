import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const tempDirs = createTrackedTempDirs();

describe("fs-safe unlink helper errors", () => {
  let removeFileWithinRoot: typeof import("./fs-safe.js").removeFileWithinRoot;
  let SafeOpenError: typeof import("./fs-safe.js").SafeOpenError;

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
    ({ removeFileWithinRoot, SafeOpenError } = await import("./fs-safe.js"));
  });

  afterEach(async () => {
    await tempDirs.cleanup();
    vi.doUnmock("./fs-pinned-write-helper.js");
    vi.resetModules();
  });

  it("preserves helper startup failures instead of rewriting them to not-found", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const targetPath = path.join(root, "note.txt");
    await fs.writeFile(targetPath, "hello", "utf8");

    try {
      await removeFileWithinRoot({
        rootDir: root,
        relativePath: "note.txt",
      });
      throw new Error("expected rooted unlink to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SafeOpenError);
      expect(error).toMatchObject({ code: "invalid-path" });
      expect(String(error)).toMatch(/Pinned unlink helper failed to start:/i);
    }

    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("hello");
  });
});
