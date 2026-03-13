import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const cleanStaleGatewayProcessesSyncMock = vi.hoisted(() => vi.fn());
const relaunchGatewayScheduledTaskMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("./restart-stale-pids.js", () => ({
  cleanStaleGatewayProcessesSync: (...args: unknown[]) =>
    cleanStaleGatewayProcessesSyncMock(...args),
  findGatewayPidsOnPortSync: vi.fn(() => []),
}));

vi.mock("./windows-task-restart.js", () => ({
  relaunchGatewayScheduledTask: (...args: unknown[]) => relaunchGatewayScheduledTaskMock(...args),
}));

import { triggerOpenClawRestart } from "./restart.js";

const envSnapshot = captureFullEnv();
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: string) {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

afterEach(() => {
  envSnapshot.restore();
  spawnSyncMock.mockReset();
  spawnMock.mockReset();
  cleanStaleGatewayProcessesSyncMock.mockReset();
  relaunchGatewayScheduledTaskMock.mockReset();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  vi.restoreAllMocks();
});

describe("triggerOpenClawRestart local script mode", () => {
  it("prefers detached local restart script on macOS when requested", async () => {
    setPlatform("darwin");
    delete process.env.VITEST;
    delete process.env.NODE_ENV;

    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-script-"));
    const scriptPath = path.join(scriptDir, "restart-local-gateway.sh");
    await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    process.env.OPENCLAW_LOCAL_RESTART_SCRIPT = scriptPath;

    const unrefMock = vi.fn();
    spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock });

    try {
      const result = triggerOpenClawRestart({ preferLocalScript: true });
      expect(result).toMatchObject({
        ok: true,
        method: "launchctl",
      });
      expect(result.detail).toContain("scheduled local restart script");
      expect(result.tried).toContain(
        `local-restart-script OPENCLAW_RESTART_DETACHED=1 /bin/bash ${scriptPath}`,
      );
      expect(cleanStaleGatewayProcessesSyncMock).toHaveBeenCalledOnce();
      expect(spawnMock).toHaveBeenCalledWith(
        "/bin/bash",
        [scriptPath],
        expect.objectContaining({
          detached: true,
          stdio: "ignore",
          env: expect.objectContaining({
            OPENCLAW_RESTART_DETACHED: "1",
          }),
        }),
      );
      expect(unrefMock).toHaveBeenCalledOnce();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  });

  it("falls back to launchctl when local script path is missing", () => {
    setPlatform("darwin");
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    process.env.OPENCLAW_LOCAL_RESTART_SCRIPT = "/tmp/definitely-missing-openclaw-restart.sh";

    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "",
      stderr: "",
    });

    const result = triggerOpenClawRestart({ preferLocalScript: true });
    expect(result).toMatchObject({
      ok: true,
      method: "launchctl",
    });
    expect(cleanStaleGatewayProcessesSyncMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "launchctl",
      expect.arrayContaining([
        "kickstart",
        "-k",
        expect.stringMatching(/^gui\/\d+\/ai\.openclaw\.gateway$/),
      ]),
      expect.objectContaining({
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  });
});
