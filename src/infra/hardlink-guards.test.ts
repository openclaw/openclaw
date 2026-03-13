import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { assertNoHardlinkedFinalPath } from "./hardlink-guards.js";

describe("assertNoHardlinkedFinalPath", () => {
  it("allows missing paths, directories, and explicit unlink opt-in", async () => {
    await withTempDir({ prefix: "openclaw-hardlink-guards-" }, async (root) => {
      const dirPath = path.join(root, "dir");
      await fs.mkdir(dirPath);

      await expect(
        assertNoHardlinkedFinalPath({
          filePath: path.join(root, "missing.txt"),
          root,
          boundaryLabel: "workspace",
        }),
      ).resolves.toBeUndefined();

      await expect(
        assertNoHardlinkedFinalPath({
          filePath: dirPath,
          root,
          boundaryLabel: "workspace",
        }),
      ).resolves.toBeUndefined();

      const source = path.join(root, "source.txt");
      const linked = path.join(root, "linked.txt");
      await fs.writeFile(source, "hello", "utf8");
      await fs.link(source, linked);

      await expect(
        assertNoHardlinkedFinalPath({
          filePath: linked,
          root,
          boundaryLabel: "workspace",
          allowFinalHardlinkForUnlink: true,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("rejects hardlinked files and shortens home-relative paths in the error", async () => {
    await withTempDir({ prefix: "openclaw-hardlink-guards-" }, async (root) => {
      const source = path.join(root, "source.txt");
      const linked = path.join(root, "linked.txt");
      await fs.writeFile(source, "hello", "utf8");
      await fs.link(source, linked);
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(root);

      try {
        await expect(
          assertNoHardlinkedFinalPath({
            filePath: linked,
            root,
            boundaryLabel: "workspace",
          }),
        ).rejects.toThrow("Hardlinked path is not allowed under workspace (~): ~/linked.txt");
      } finally {
        homedirSpy.mockRestore();
      }
    });
  });
});
