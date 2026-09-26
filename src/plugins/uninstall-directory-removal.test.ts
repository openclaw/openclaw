import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyPluginUninstallDirectoryRemoval } from "./uninstall.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin uninstall directory removal", () => {
  it("retains plugin files when the operation loses authority before removal", async () => {
    const root = tempDirs.make("openclaw-plugin-uninstall-");
    const target = path.join(root, "plugin");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "index.js"), "export default {};");
    await expect(
      applyPluginUninstallDirectoryRemoval({ target }, () => {
        throw new Error("lifecycle lease lost");
      }),
    ).rejects.toThrow("lifecycle lease lost");
    expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("export default {};");
  });
  it("removes a dangling managed-target symlink", async () => {
    const root = tempDirs.make("openclaw-plugin-uninstall-");
    const target = path.join(root, "plugin");
    await fs.symlink(path.join(root, "missing-target"), target, "dir");

    await expect(fs.lstat(target)).resolves.toBeDefined();
    await expect(applyPluginUninstallDirectoryRemoval({ target })).resolves.toEqual({
      directoryRemoved: true,
      warnings: [],
    });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
