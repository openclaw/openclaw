import fs from "node:fs";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const closeTrackedBrowserTabsForSessionsImpl = vi.hoisted(() => vi.fn());
const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const runExec = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

vi.mock("../process/exec.js", () => ({
  runExec,
}));

describe("browser maintenance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    closeTrackedBrowserTabsForSessionsImpl.mockReset();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    runExec.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(123);
    vi.spyOn(os, "homedir").mockReturnValue("/home/test");
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabsForSessionsImpl,
    });
  });

  it("skips browser cleanup when no session keys are provided", async () => {
    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [] })).resolves.toBe(0);
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("delegates cleanup through the browser maintenance surface", async () => {
    closeTrackedBrowserTabsForSessionsImpl.mockResolvedValue(2);

    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:test"] }),
    ).resolves.toBe(2);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });
    expect(closeTrackedBrowserTabsForSessionsImpl).toHaveBeenCalledWith({
      sessionKeys: ["agent:main:test"],
    });
  });

  it("moves paths to the user trash without invoking a PATH-resolved command", async () => {
    const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const existsSync = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
    const cpSync = vi.spyOn(fs, "cpSync");
    const rmSync = vi.spyOn(fs, "rmSync");

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/home/test/.Trash/demo-123");
    expect(runExec).not.toHaveBeenCalled();
    expect(mkdirSync).toHaveBeenCalledWith("/home/test/.Trash", { recursive: true });
    expect(existsSync).toHaveBeenCalledWith("/home/test/.Trash/demo-123");
    expect(renameSync).toHaveBeenCalledWith("/tmp/demo", "/home/test/.Trash/demo-123");
    expect(cpSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("falls back to copy and remove when rename crosses filesystems", async () => {
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw exdev;
    });
    const cpSync = vi.spyOn(fs, "cpSync").mockImplementation(() => undefined);
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/home/test/.Trash/demo-123");
    expect(cpSync).toHaveBeenCalledWith("/tmp/demo", "/home/test/.Trash/demo-123", {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(rmSync).toHaveBeenCalledWith("/tmp/demo", { recursive: true, force: true });
  });

  it("retries copy fallback when the copy destination is created concurrently", async () => {
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const copyCollision = Object.assign(new Error("copy exists"), {
      code: "ERR_FS_CP_EEXIST",
    });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw exdev;
    });
    const cpSync = vi
      .spyOn(fs, "cpSync")
      .mockImplementationOnce(() => {
        throw copyCollision;
      })
      .mockImplementation(() => undefined);
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toMatch(
      /^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/,
    );
    expect(cpSync).toHaveBeenNthCalledWith(1, "/tmp/demo", "/home/test/.Trash/demo-123", {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(cpSync).toHaveBeenNthCalledWith(
      2,
      "/tmp/demo",
      expect.stringMatching(/^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/),
      {
        recursive: true,
        force: false,
        errorOnExist: true,
      },
    );
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it("retries with the same timestamp when the destination is created concurrently", async () => {
    const collision = Object.assign(new Error("exists"), { code: "EEXIST" });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const renameSync = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw collision;
      })
      .mockImplementation(() => undefined);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toMatch(
      /^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/,
    );
    expect(renameSync).toHaveBeenNthCalledWith(1, "/tmp/demo", "/home/test/.Trash/demo-123");
    expect(renameSync).toHaveBeenNthCalledWith(
      2,
      "/tmp/demo",
      expect.stringMatching(/^\/home\/test\/\.Trash\/demo-123-[A-Za-z0-9_-]+$/),
    );
    expect(Date.now).toHaveBeenCalledTimes(1);
  });
});
