import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  loadBundledPluginPublicSurfaceModuleSyncCore: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("../plugin-sdk/facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSyncCore: mocks.loadBundledPluginPublicSurfaceModuleSyncCore,
}));

import { createWorkerBrowserToolRuntime } from "./browser-runtime.js";

const options = {
  descriptor: {
    cdpUrl: "http://127.0.0.1:9222",
    launcherPath: "/usr/local/bin/openclaw-worker-browser",
  },
  sessionKey: "worker:session-1",
  stateDir: "/tmp/worker-state",
  workspaceDir: "/tmp/workspace",
};
const dispose = vi.fn().mockResolvedValue(undefined);
const createAttachedBrowserToolRuntime = vi.fn();

function completeLaunch(error: Error | null) {
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _options: object, callback: (error: Error | null) => void) => {
      callback(error);
      return {};
    },
  );
}

function ensureAttachTarget() {
  const attach = createAttachedBrowserToolRuntime.mock.calls[0]?.[0]
    .ensureAttachTarget as () => Promise<void>;
  return attach();
}

describe("worker Browser runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAttachedBrowserToolRuntime.mockResolvedValue({ tool: { name: "browser" }, dispose });
    mocks.loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      createAttachedBrowserToolRuntime,
    });
    completeLaunch(null);
  });

  it.each([
    { launcherArgs: undefined },
    { launcherArgs: ["-File", "C:\\ProgramData\\OpenClaw\\browser.ps1", "literal;$(text)"] },
  ])(
    "launches the provider executable with fixed args $launcherArgs without a shell",
    async ({ launcherArgs }) => {
      const runtime = await createWorkerBrowserToolRuntime({
        ...options,
        descriptor: { ...options.descriptor, ...(launcherArgs ? { launcherArgs } : {}) },
      });

      expect(mocks.loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledWith({
        dirName: "browser",
        artifactBasename: "runtime-api.js",
        trackedPluginId: "browser",
      });
      expect(createAttachedBrowserToolRuntime).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:9222",
        ensureAttachTarget: expect.any(Function),
        agentSessionKey: "worker:session-1",
        agentDir: "/tmp/worker-state",
        workspaceDir: "/tmp/workspace",
      });

      await ensureAttachTarget();
      expect(mocks.execFile).toHaveBeenCalledWith(
        "/usr/local/bin/openclaw-worker-browser",
        launcherArgs ?? [],
        {
          timeout: 30_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          shell: false,
        },
        expect.any(Function),
      );

      await runtime.dispose();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("uses the build-composed Browser runtime without filesystem discovery", async () => {
    await createWorkerBrowserToolRuntime({
      ...options,
      runtime: { createAttachedBrowserToolRuntime },
    });

    expect(createAttachedBrowserToolRuntime).toHaveBeenCalledOnce();
    expect(mocks.loadBundledPluginPublicSurfaceModuleSyncCore).not.toHaveBeenCalled();
  });

  it("surfaces launcher failure without loading another browser route", async () => {
    completeLaunch(new Error("launcher timed out"));
    await createWorkerBrowserToolRuntime(options);

    await expect(ensureAttachTarget()).rejects.toThrow(
      "Worker Browser launcher failed: launcher timed out",
    );
    expect(mocks.loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledOnce();
  });
});
