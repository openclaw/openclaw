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
    closeTrackedBrowserTabsForSessionsImpl.mockReset();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    runExec.mockReset();
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

  it("uses the local trash command before falling back", async () => {
    runExec.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
    });

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/tmp/demo");
    expect(runExec).toHaveBeenCalledWith("trash", ["/tmp/demo"], { timeoutMs: 10_000 });
  });
});
