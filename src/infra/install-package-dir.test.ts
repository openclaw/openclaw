import fsSync from "node:fs";
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

function normalizeDarwinTmpPath(filePath: string): string {
  return process.platform === "darwin" && filePath.startsWith("/private/var/")
    ? filePath.slice("/private".length)
    : filePath;
}

function normalizeComparablePath(filePath: string): string {
  const resolved = normalizeDarwinTmpPath(path.resolve(filePath));
  const parent = normalizeDarwinTmpPath(path.dirname(resolved));
  let comparableParent = parent;
  try {
    comparableParent = normalizeDarwinTmpPath(fsSync.realpathSync.native(parent));
  } catch {
    comparableParent = parent;
  }
  const basename =
    process.platform === "win32" ? path.basename(resolved).toLowerCase() : path.basename(resolved);
  return path.join(comparableParent, basename);
}

async function rebindInstallBasePath(params: {
  installBaseDir: string;
  preservedDir: string;
  outsideTarget: string;
}): Promise<void> {
  await fs.rename(params.installBaseDir, params.preservedDir);
  await fs.symlink(
    params.outsideTarget,
    params.installBaseDir,
    process.platform === "win32" ? "junction" : undefined,
  );
}

async function withInstallBaseReboundOnRealpathCall<T>(params: {
  installBaseDir: string;
  preservedDir: string;
  outsideTarget: string;
  rebindAtCall: number;
  run: () => Promise<T>;
}): Promise<T> {
  const installBasePath = normalizeComparablePath(params.installBaseDir);
  const realRealpath = fs.realpath.bind(fs);
  let installBaseRealpathCalls = 0;
  const realpathSpy = vi
    .spyOn(fs, "realpath")
    .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      const filePath = normalizeComparablePath(String(args[0]));
      if (filePath === installBasePath) {
        installBaseRealpathCalls += 1;
        if (installBaseRealpathCalls === params.rebindAtCall) {
          await rebindInstallBasePath({
            installBaseDir: params.installBaseDir,
            preservedDir: params.preservedDir,
            outsideTarget: params.outsideTarget,
          });
        }
      }
      return await realRealpath(...args);
    });
  try {
    return await params.run();
  } finally {
    realpathSpy.mockRestore();
  }
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

  it("aborts without outside writes when the install base is rebound before publish", async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-package-dir-"));
    const sourceDir = path.join(fixtureRoot, "source");
    const installBaseDir = path.join(fixtureRoot, "plugins");
    const preservedInstallRoot = path.join(fixtureRoot, "plugins-preserved");
    const outsideInstallRoot = path.join(fixtureRoot, "outside-plugins");
    const targetDir = path.join(installBaseDir, "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(installBaseDir, { recursive: true });
    await fs.mkdir(outsideInstallRoot, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");

    const warnings: string[] = [];
    await withInstallBaseReboundOnRealpathCall({
      installBaseDir,
      preservedDir: preservedInstallRoot,
      outsideTarget: outsideInstallRoot,
      rebindAtCall: 3,
      run: async () => {
        await expect(
          installPackageDir({
            sourceDir,
            targetDir,
            mode: "install",
            timeoutMs: 1_000,
            copyErrorPrefix: "failed to copy plugin",
            hasDeps: false,
            depsLogMessage: "Installing deps…",
            logger: { warn: (message) => warnings.push(message) },
          }),
        ).resolves.toEqual({
          ok: false,
          error: "failed to copy plugin: Error: install base directory changed during install",
        });
      },
    });

    await expect(
      fs.stat(path.join(outsideInstallRoot, "demo", "marker.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(warnings).toContain(
      "Install base directory changed during install; aborting staged publish.",
    );
  });

  it("warns and leaves the backup in place when the install base changes before backup cleanup", async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-package-dir-"));
    const sourceDir = path.join(fixtureRoot, "source");
    const installBaseDir = path.join(fixtureRoot, "plugins");
    const preservedInstallRoot = path.join(fixtureRoot, "plugins-preserved");
    const outsideInstallRoot = path.join(fixtureRoot, "outside-plugins");
    const targetDir = path.join(installBaseDir, "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(installBaseDir, { recursive: true });
    await fs.mkdir(outsideInstallRoot, { recursive: true });
    await fs.mkdir(path.join(installBaseDir, "demo"), { recursive: true });
    await fs.writeFile(path.join(installBaseDir, "demo", "marker.txt"), "old");
    await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");

    const warnings: string[] = [];
    const result = await withInstallBaseReboundOnRealpathCall({
      installBaseDir,
      preservedDir: preservedInstallRoot,
      outsideTarget: outsideInstallRoot,
      rebindAtCall: 7,
      run: async () =>
        await installPackageDir({
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          depsLogMessage: "Installing deps…",
          logger: { warn: (message) => warnings.push(message) },
        }),
    });

    expect(result).toEqual({ ok: true });
    expect(warnings).toContain(
      "Install base directory changed before backup cleanup; leaving backup in place.",
    );
    await expect(
      fs.stat(path.join(outsideInstallRoot, "demo", "marker.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const backupRoot = path.join(preservedInstallRoot, ".openclaw-install-backups");
    await expect(fs.readdir(backupRoot)).resolves.toHaveLength(1);
  });
});
