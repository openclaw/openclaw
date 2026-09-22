/**
 * Tests browser maintenance facade loading and cleanup behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeTrackedBrowserTabsForSessionsImpl = vi.hoisted(() => vi.fn());
const tryLoadActivatedBundledPluginPublicSurfaceModule = vi.hoisted(() => vi.fn());
const runExec = vi.hoisted(() => vi.fn());
const realMkdirSync = fs.mkdirSync.bind(fs);
const realMkdtempSync = fs.mkdtempSync.bind(fs);
const realRmSync = fs.rmSync.bind(fs);
const realWriteFileSync = fs.writeFileSync.bind(fs);
const realRealpathSyncNative = fs.realpathSync.native.bind(fs.realpathSync);
const realCpSync = fs.cpSync.bind(fs);

vi.mock("./facade-runtime.js", () => ({
  tryLoadActivatedBundledPluginPublicSurfaceModule,
}));

vi.mock("../process/exec.js", () => ({
  runExec,
}));

describe("browser maintenance", () => {
  let testRoot = "";
  let homeDir = "";
  let tmpDir = "";

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    testRoot = realRealpathSyncNative(
      realMkdtempSync(path.join(os.tmpdir(), "openclaw-browser-maintenance-")),
    );
    homeDir = path.join(testRoot, "home", "test");
    tmpDir = path.join(testRoot, "tmp");
    realMkdirSync(path.join(homeDir, ".Trash"), { recursive: true, mode: 0o700 });
    realMkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    closeTrackedBrowserTabsForSessionsImpl.mockReset();
    tryLoadActivatedBundledPluginPublicSurfaceModule.mockReset();
    runExec.mockReset();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.spyOn(os, "tmpdir").mockReturnValue(tmpDir);
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) =>
      realRealpathSyncNative(candidate),
    );
    tryLoadActivatedBundledPluginPublicSurfaceModule.mockResolvedValue({
      closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabsForSessionsImpl,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (testRoot) {
      realRmSync(testRoot, { recursive: true, force: true });
    }
  });

  function writeTrashTarget(name = "demo"): string {
    const target = path.join(tmpDir, name);
    realWriteFileSync(target, "demo");
    return target;
  }

  function expectTrashDestination(
    destination: string,
    target: string,
    trashDir = path.join(homeDir, ".Trash"),
  ) {
    expect(destination.startsWith(`${trashDir}${path.sep}`)).toBe(true);
    expect(path.basename(destination)).toBe(path.basename(target));
    expect(fs.realpathSync.native(destination)).toBe(destination);
    const reservation = path.dirname(destination);
    expect(reservation).not.toBe(trashDir);
    const stat = fs.lstatSync(reservation);
    expect(stat.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o700);
    }
  }

  function expectMovedTarget(target: string, destination: string, trashDir?: string) {
    expectTrashDestination(destination, target, trashDir);
    expect(fs.readFileSync(destination, "utf8")).toBe("demo");
    expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
  }

  it("skips browser cleanup when no session keys are provided", async () => {
    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [] })).resolves.toBe(0);
    expect(tryLoadActivatedBundledPluginPublicSurfaceModule).not.toHaveBeenCalled();
  });

  it("skips browser cleanup when the browser plugin is disabled", async () => {
    tryLoadActivatedBundledPluginPublicSurfaceModule.mockResolvedValue(null);

    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:test"] }),
    ).resolves.toBe(0);
    expect(tryLoadActivatedBundledPluginPublicSurfaceModule).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });
    expect(closeTrackedBrowserTabsForSessionsImpl).not.toHaveBeenCalled();
  });

  it("reports unavailable browser cleanup when async activation fails", async () => {
    tryLoadActivatedBundledPluginPublicSurfaceModule.mockRejectedValue(
      new Error("activation unavailable"),
    );
    const onWarn = vi.fn();
    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:test"], onWarn }),
    ).resolves.toBe(0);
    expect(onWarn).toHaveBeenCalledWith(
      "browser cleanup unavailable: Error: activation unavailable",
    );
    expect(closeTrackedBrowserTabsForSessionsImpl).not.toHaveBeenCalled();
  });

  it("rechecks plugin activation before using a cached browser cleanup surface", async () => {
    closeTrackedBrowserTabsForSessionsImpl.mockResolvedValue(2);

    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:test"] }),
    ).resolves.toBe(2);
    tryLoadActivatedBundledPluginPublicSurfaceModule.mockResolvedValue(null);
    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:test"] }),
    ).resolves.toBe(0);

    expect(closeTrackedBrowserTabsForSessionsImpl).toHaveBeenCalledTimes(1);
  });

  it("delegates cleanup through the browser maintenance surface", async () => {
    closeTrackedBrowserTabsForSessionsImpl.mockResolvedValue(2);

    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:test"] }),
    ).resolves.toBe(2);
    expect(tryLoadActivatedBundledPluginPublicSurfaceModule).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });
    expect(closeTrackedBrowserTabsForSessionsImpl).toHaveBeenCalledWith({
      sessionKeys: ["agent:main:test"],
    });
  });

  it("moves paths to a reserved user trash container without invoking a PATH-resolved command", async () => {
    const trashDir = path.join(homeDir, ".Trash");
    realRmSync(trashDir, { recursive: true });
    const renameSync = vi.spyOn(fs, "renameSync");
    const cpSync = vi.spyOn(fs, "cpSync");
    const rmSync = vi.spyOn(fs, "rmSync");

    const { movePathToTrash } = await import("./browser-maintenance.js");
    const target = writeTrashTarget();
    const original = fs.lstatSync(target, { bigint: true });

    const moved = await movePathToTrash(target);
    expectMovedTarget(target, moved);
    expect(runExec).not.toHaveBeenCalled();
    if (process.platform !== "win32") {
      expect(fs.lstatSync(trashDir).mode & 0o777).toBe(0o700);
    }
    expect(fs.lstatSync(moved, { bigint: true }).ino).toBe(original.ino);
    expect(renameSync).toHaveBeenCalledWith(target, moved);
    expect(cpSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("uses the resolved trash directory for reserved destinations", async () => {
    const resolvedHomeDir = path.join(testRoot, "real", "home", "test");
    const resolvedTrashDir = path.join(resolvedHomeDir, ".Trash");
    realMkdirSync(path.join(homeDir, ".Trash"), { recursive: true, mode: 0o700 });
    realMkdirSync(resolvedTrashDir, { recursive: true, mode: 0o700 });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
      const value = String(candidate);
      if (value === homeDir) {
        return resolvedHomeDir;
      }
      if (value === path.join(homeDir, ".Trash")) {
        return resolvedTrashDir;
      }
      return realRealpathSyncNative(candidate);
    });
    const renameSync = vi.spyOn(fs, "renameSync");

    const { movePathToTrash } = await import("./browser-maintenance.js");
    const target = writeTrashTarget();

    const moved = await movePathToTrash(target);
    expectMovedTarget(target, moved, resolvedTrashDir);
    expect(renameSync).toHaveBeenCalledWith(target, moved);
    expect(fs.readdirSync(path.join(homeDir, ".Trash"))).toEqual([]);
  });

  it("refuses to trash filesystem roots", async () => {
    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/")).rejects.toThrow("Refusing to trash root path");
  });

  it("refuses to trash paths outside allowed roots", async () => {
    const { movePathToTrash } = await import("./browser-maintenance.js");
    const outsideDir = path.join(testRoot, "outside");
    realMkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, "openclaw-demo");
    realWriteFileSync(outsidePath, "outside");

    await expect(movePathToTrash(outsidePath)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  });

  it("refuses to use a symlinked trash directory", async () => {
    const realTrashDir = path.join(testRoot, "real-trash");
    realRmSync(path.join(homeDir, ".Trash"), { recursive: true, force: true });
    realMkdirSync(realTrashDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(realTrashDir, path.join(homeDir, ".Trash"), "dir");
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash(writeTrashTarget())).rejects.toThrow(
      "Refusing to use non-directory/symlink trash directory",
    );
  });

  it("falls back to copy and remove when rename crosses filesystems", async () => {
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw exdev;
    });
    const cpSync = vi.spyOn(fs, "cpSync");
    const rmSync = vi.spyOn(fs, "rmSync");

    const { movePathToTrash } = await import("./browser-maintenance.js");
    const target = writeTrashTarget();
    const original = fs.lstatSync(target, { bigint: true });

    const moved = await movePathToTrash(target);
    expectMovedTarget(target, moved);
    expect(fs.lstatSync(moved, { bigint: true }).ino).not.toBe(original.ino);
    expect(cpSync).toHaveBeenCalledWith(target, moved, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(rmSync).toHaveBeenCalledWith(target, { recursive: true, force: false });
  });

  it("retries copy fallback when the copy destination is created concurrently", async () => {
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw exdev;
    });
    let first = "";
    let firstInode: bigint | undefined;
    const cpSync = vi.spyOn(fs, "cpSync").mockImplementationOnce((source, destination, options) => {
      first = String(destination);
      realWriteFileSync(destination, "occupied");
      firstInode = fs.lstatSync(destination, { bigint: true }).ino;
      expect(fs.readFileSync(source, "utf8")).toBe("demo");
      realCpSync(source, destination, options);
    });
    const rmSync = vi.spyOn(fs, "rmSync");

    const { movePathToTrash } = await import("./browser-maintenance.js");
    const target = writeTrashTarget();

    const moved = await movePathToTrash(target);
    expectMovedTarget(target, moved);
    expectTrashDestination(first, target);
    expect(moved).not.toBe(first);
    expect(fs.readFileSync(first, "utf8")).toBe("occupied");
    expect(fs.lstatSync(first, { bigint: true }).ino).toBe(firstInode);
    expect(cpSync).toHaveBeenCalledTimes(2);
    expect(cpSync).toHaveBeenNthCalledWith(1, target, first, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(cpSync).toHaveBeenNthCalledWith(2, target, moved, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(rmSync).toHaveBeenCalledWith(target, { recursive: true, force: false });
  });

  it("retries in a fresh reservation when the rename destination is created concurrently", async () => {
    const collision = Object.assign(new Error("exists"), { code: "EEXIST" });
    let first = "";
    let firstInode: bigint | undefined;
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementationOnce((source, destination) => {
      first = String(destination);
      realWriteFileSync(destination, "occupied");
      firstInode = fs.lstatSync(destination, { bigint: true }).ino;
      expect(fs.readFileSync(source, "utf8")).toBe("demo");
      throw collision;
    });
    const cpSync = vi.spyOn(fs, "cpSync");
    const rmSync = vi.spyOn(fs, "rmSync");

    const { movePathToTrash } = await import("./browser-maintenance.js");
    const target = writeTrashTarget();

    const moved = await movePathToTrash(target);
    expectMovedTarget(target, moved);
    expectTrashDestination(first, target);
    expect(moved).not.toBe(first);
    expect(fs.readFileSync(first, "utf8")).toBe("occupied");
    expect(fs.lstatSync(first, { bigint: true }).ino).toBe(firstInode);
    expect(renameSync).toHaveBeenCalledTimes(2);
    expect(renameSync).toHaveBeenNthCalledWith(1, target, first);
    expect(renameSync).toHaveBeenNthCalledWith(2, target, moved);
    expect(cpSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });
});
