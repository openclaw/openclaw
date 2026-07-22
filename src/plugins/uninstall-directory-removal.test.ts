import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPluginUninstallDirectoryRemoval } from "./uninstall.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })),
  );
});

describe("plugin uninstall directory removal", () => {
  it("removes a dangling managed-target symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-uninstall-"));
    cleanupPaths.push(root);
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
