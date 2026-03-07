import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPackageDir } from "./install-package-dir.js";

async function listMatchingDirs(root: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name);
}

describe("installPackageDir", () => {
  let fixtureRoot = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = "";
    }
  });

  it("keeps the existing install in place when staged validation fails", async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-package-dir-"));
    const installBaseDir = path.join(fixtureRoot, "plugins");
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(installBaseDir, "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");
    await fs.writeFile(path.join(targetDir, "marker.txt"), "old");

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "update",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: false,
      depsLogMessage: "Installing deps…",
      afterCopy: async (installedDir) => {
        expect(installedDir).not.toBe(targetDir);
        await expect(fs.readFile(path.join(installedDir, "marker.txt"), "utf8")).resolves.toBe(
          "new",
        );
        throw new Error("validation boom");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "post-copy validation failed: Error: validation boom",
    });
    await expect(fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).resolves.toBe("old");
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-backups"),
    ).resolves.toHaveLength(0);
  });

  it("restores the original install if publish rename fails", async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-package-dir-"));
    const installBaseDir = path.join(fixtureRoot, "plugins");
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(installBaseDir, "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");
    await fs.writeFile(path.join(targetDir, "marker.txt"), "old");

    const realRename = fs.rename.bind(fs);
    let renameCalls = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      renameCalls += 1;
      if (renameCalls === 2) {
        throw new Error("publish boom");
      }
      return await realRename(...args);
    });

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "update",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: false,
      depsLogMessage: "Installing deps…",
    });

    expect(result).toEqual({
      ok: false,
      error: "failed to copy plugin: Error: publish boom",
    });
    await expect(fs.readFile(path.join(targetDir, "marker.txt"), "utf8")).resolves.toBe("old");
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
    const backupRoot = path.join(installBaseDir, ".openclaw-install-backups");
    await expect(fs.readdir(backupRoot)).resolves.toHaveLength(0);
  });
});
