import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";

const spawnMock = vi.hoisted(() => vi.fn());
const relaunchGatewayScheduledTaskMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
    },
  );
});
vi.mock("./windows-task-restart.js", () => ({
  relaunchGatewayScheduledTask: (...args: unknown[]) => relaunchGatewayScheduledTaskMock(...args),
}));

import {
  respawnGatewayProcessForUpdate,
  restartGatewayProcessWithFreshPid,
} from "./process-respawn.js";

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
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
  process.argv = [...originalArgv];
  process.execArgv = [...originalExecArgv];
  spawnMock.mockClear();
  relaunchGatewayScheduledTaskMock.mockClear();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

function clearSupervisorHints() {
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    delete process.env[key];
  }
}

function expectLaunchdSupervisedWithoutKickstart(params?: { launchJobLabel?: string }) {
  setPlatform("darwin");
  if (params?.launchJobLabel) {
    process.env.LAUNCH_JOB_LABEL = params.launchJobLabel;
  }
  process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
  const result = restartGatewayProcessWithFreshPid();
  expect(result).toEqual({ mode: "supervised" });
  expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
}

describe("restartGatewayProcessWithFreshPid", () => {
  it("returns disabled when OPENCLAW_NO_RESPAWN is set", () => {
    process.env.OPENCLAW_NO_RESPAWN = "1";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("disabled");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps OPENCLAW_NO_RESPAWN ahead of inherited supervisor hints", () => {
    clearSupervisorHints();
    setPlatform("darwin");
    process.env.OPENCLAW_NO_RESPAWN = "1";
    process.env.LAUNCH_JOB_LABEL = "ai.openclaw.gateway";

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({ mode: "disabled" });
    expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when launchd hints are present on macOS (no kickstart)", () => {
    clearSupervisorHints();
    expectLaunchdSupervisedWithoutKickstart({ launchJobLabel: "ai.openclaw.gateway" });
  });

  it("returns supervised on macOS when launchd label is set (no kickstart)", () => {
    expectLaunchdSupervisedWithoutKickstart({ launchJobLabel: "ai.openclaw.gateway" });
  });

  it("launchd supervisor never calls the Windows scheduled-task relaunch", () => {
    clearSupervisorHints();
    setPlatform("darwin");
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    // Even if the scheduled-task relaunch *would* fail, launchd path must not call it.
    relaunchGatewayScheduledTaskMock.mockReturnValue({
      ok: false,
      method: "schtasks",
      detail: "mocked failure",
    });
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(result.mode).not.toBe("failed");
    expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
  });

  it("does not schedule kickstart on non-darwin platforms", () => {
    setPlatform("linux");
    process.env.INVOCATION_ID = "abc123";
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";

    const result = restartGatewayProcessWithFreshPid();

    expect(result.mode).toBe("supervised");
    expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when XPC_SERVICE_NAME is set by launchd", () => {
    clearSupervisorHints();
    setPlatform("darwin");
    process.env.XPC_SERVICE_NAME = "ai.openclaw.gateway";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns detached child with current exec argv", () => {
    delete process.env.OPENCLAW_NO_RESPAWN;
    clearSupervisorHints();
    setPlatform("linux");
    process.execArgv = ["--import", "tsx"];
    process.argv = ["/usr/local/bin/node", "/repo/dist/index.js", "gateway", "run"];
    spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({ mode: "spawned", pid: 4242 });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["--import", "tsx", "/repo/dist/index.js", "gateway", "run"],
      expect.objectContaining({
        detached: true,
        stdio: "inherit",
      }),
    );
  });

  it("returns supervised when OPENCLAW_LAUNCHD_LABEL is set (stock launchd plist)", () => {
    clearSupervisorHints();
    expectLaunchdSupervisedWithoutKickstart();
  });

  it("returns supervised when OPENCLAW_SYSTEMD_UNIT is set", () => {
    clearSupervisorHints();
    setPlatform("linux");
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when OpenClaw gateway task markers are set on Windows", () => {
    clearSupervisorHints();
    setPlatform("win32");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";
    relaunchGatewayScheduledTaskMock.mockReturnValue({ ok: true, method: "schtasks" });
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(relaunchGatewayScheduledTaskMock).toHaveBeenCalledOnce();
    expect(relaunchGatewayScheduledTaskMock).toHaveBeenCalledWith(process.env);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("propagates schtasks failure as mode=failed on Windows", () => {
    clearSupervisorHints();
    setPlatform("win32");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";
    relaunchGatewayScheduledTaskMock.mockReturnValue({
      ok: false,
      method: "schtasks",
      detail: "scheduled task not registered",
    });
    const result = restartGatewayProcessWithFreshPid();
    expect(result).toEqual({ mode: "failed", detail: "scheduled task not registered" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps generic service markers out of non-Windows supervisor detection", () => {
    clearSupervisorHints();
    setPlatform("linux");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";
    spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({ mode: "spawned", pid: 4242 });
    expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
  });

  it("returns disabled on Windows without Scheduled Task markers", () => {
    clearSupervisorHints();
    setPlatform("win32");

    const result = restartGatewayProcessWithFreshPid();

    expect(result.mode).toBe("disabled");
    expect(result.detail).toContain("Scheduled Task");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("ignores node task script hints for gateway restart detection on Windows", () => {
    clearSupervisorHints();
    setPlatform("win32");
    process.env.OPENCLAW_TASK_SCRIPT = "C:\\openclaw\\node.cmd";
    process.env.OPENCLAW_TASK_SCRIPT_NAME = "node.cmd";
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "node";

    const result = restartGatewayProcessWithFreshPid();

    expect(result.mode).toBe("disabled");
    expect(relaunchGatewayScheduledTaskMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns failed when spawn throws", () => {
    delete process.env.OPENCLAW_NO_RESPAWN;
    clearSupervisorHints();
    setPlatform("linux");

    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("failed");
    expect(result.detail).toContain("spawn failed");
  });
});

describe("respawnGatewayProcessForUpdate", () => {
  it("keeps OPENCLAW_NO_RESPAWN semantics for update restarts", () => {
    clearSupervisorHints();
    process.env.OPENCLAW_NO_RESPAWN = "1";

    const result = respawnGatewayProcessForUpdate();

    expect(result).toEqual({ mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("allows detached respawn on unmanaged Windows during updates", () => {
    clearSupervisorHints();
    setPlatform("win32");
    process.execArgv = [];
    process.argv = [
      "C:\\Program Files\\node.exe",
      "C:\\openclaw\\dist\\index.js",
      "gateway",
      "run",
    ];
    spawnMock.mockReturnValue({ pid: 5151, unref: vi.fn(), kill: vi.fn() });

    const result = respawnGatewayProcessForUpdate();

    expect(result.mode).toBe("spawned");
    expect(result.pid).toBe(5151);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["C:\\openclaw\\dist\\index.js", "gateway", "run"],
      expect.objectContaining({
        detached: true,
        env: process.env,
        stdio: "inherit",
      }),
    );
  });
});
