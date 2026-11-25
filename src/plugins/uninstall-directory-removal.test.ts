import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyPluginUninstallDirectoryRemoval } from "./uninstall.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin uninstall directory removal", () => {
  it("removes dependency trees deeper than the library's default traversal budget", async () => {
    const target = path.join(tempDirs.make("openclaw-uninstall-deep-"), "plugin");
    const nested = path.join(target, ...Array.from({ length: 66 }, () => "d"));
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "entry.js"), "export default {};\n");

    await expect(applyPluginUninstallDirectoryRemoval({ target })).resolves.toEqual({
      directoryRemoved: true,
      warnings: [],
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it.each([
    { kind: "Error", refusal: new Error("lifecycle authority revoked") },
    {
      kind: "errno-shaped",
      refusal: Object.assign(new Error("lifecycle authority revoked"), { code: "ENOENT" }),
    },
    { kind: "falsy", refusal: false },
  ])("stops recursive removal after a $kind authority refusal", async ({ refusal }) => {
    const root = tempDirs.make("openclaw-plugin-uninstall-revoked-");
    const target = path.join(root, "plugin");
    const files = [path.join(target, "a.js"), path.join(target, "b.js")];
    const controller = new AbortController();
    await fs.mkdir(target);
    await Promise.all(files.map((file) => fs.writeFile(file, "retained plugin bytes")));

    await expect
      .soft(
        applyPluginUninstallDirectoryRemoval({ target }, () => {
          if (files.some((file) => !existsSync(file))) {
            controller.abort(refusal);
          }
          controller.signal.throwIfAborted();
        }),
      )
      .rejects.toBe(refusal);

    const survivingFiles = files.filter((file) => existsSync(file));
    expect(survivingFiles).toHaveLength(1);
    for (const file of survivingFiles) {
      expect(await fs.readFile(file, "utf8")).toBe("retained plugin bytes");
    }
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
