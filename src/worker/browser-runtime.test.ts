import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), loadRuntime: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

vi.mock("../plugin-sdk/facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSyncCore: mocks.loadRuntime,
}));

import { createWorkerBrowserToolRuntime } from "./browser-runtime.js";

const options = {
  descriptor: { cdpUrl: "http://127.0.0.1:9222", launcherPath: "/worker-browser" },
  sessionKey: "agent:worker-agent:worker:session-1",
  stateDir: "/tmp/worker-state",
  workspaceDir: "/tmp/workspace",
};
const dispose = vi.fn().mockResolvedValue(undefined);
const attach = vi.fn();

function completeLaunch(error: Error | null) {
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _options: object, callback: (error: Error | null) => void) => {
      callback(error);
      return {};
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  attach.mockResolvedValue({ tool: { name: "browser" }, dispose });
  mocks.loadRuntime.mockReturnValue({ createAttachedBrowserToolRuntime: attach });
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

    expect(mocks.loadRuntime).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "runtime-api.js",
      trackedPluginId: "browser",
    });
    expect(attach).toHaveBeenCalledWith({
      cdpUrl: options.descriptor.cdpUrl,
      ensureAttachTarget: expect.any(Function),
      agentSessionKey: options.sessionKey,
      agentDir: options.stateDir,
      workspaceDir: options.workspaceDir,
    });

    await attach.mock.calls[0]?.[0].ensureAttachTarget();
    expect(mocks.execFile).toHaveBeenCalledWith(
      options.descriptor.launcherPath,
      launcherArgs ?? [],
      { timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true, shell: false },
      expect.any(Function),
    );

    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  },
);

it("uses the build-composed Browser runtime without filesystem discovery", async () => {
  await createWorkerBrowserToolRuntime({
    ...options,
    runtime: { createAttachedBrowserToolRuntime: attach },
  });

  expect(attach).toHaveBeenCalledOnce();
  expect(mocks.loadRuntime).not.toHaveBeenCalled();
});

it("surfaces launcher failure without loading another browser route", async () => {
  completeLaunch(new Error("launcher timed out"));
  await createWorkerBrowserToolRuntime(options);

  await expect(attach.mock.calls[0]?.[0].ensureAttachTarget()).rejects.toThrow(
    "Worker Browser launcher failed: launcher timed out",
  );
  expect(mocks.loadRuntime).toHaveBeenCalledOnce();
});
