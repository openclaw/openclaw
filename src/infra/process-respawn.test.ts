import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";

const spawnMock = vi.hoisted(() => vi.fn());
const triggerOpenClawRestartMock = vi.hoisted(() => vi.fn());
const scheduleDetachedLaunchdRestartHandoffMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
}));
vi.mock("./restart.js", () => ({
  triggerOpenClawRestart: (...args: unknown[]) => triggerOpenClawRestartMock(...args),
}));
vi.mock("../daemon/launchd-restart-handoff.js", () => ({
  scheduleDetachedLaunchdRestartHandoff: (...args: unknown[]) =>
    scheduleDetachedLaunchdRestartHandoffMock(...args),
}));
vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: (...args: unknown[]) =>
    resolveOpenClawPackageRootSyncMock(...args),
}));

import { restartGatewayProcessWithFreshPid } from "./process-respawn.js";

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
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
  triggerOpenClawRestartMock.mockClear();
  scheduleDetachedLaunchdRestartHandoffMock.mockReset();
  scheduleDetachedLaunchdRestartHandoffMock.mockReturnValue({ ok: true, pid: 8123 });
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
  resolveOpenClawPackageRootSyncMock.mockReset();
  resolveOpenClawPackageRootSyncMock.mockReturnValue(null);
  if (originalExecPathDescriptor) {
    Object.defineProperty(process, "execPath", originalExecPathDescriptor);
  }
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

function clearSupervisorHints() {
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    delete process.env[key];
  }
}

function expectLaunchdSupervisedWithoutKickstart(params?: {
  launchJobLabel?: string;
  detailContains?: string;
}) {
  setPlatform("darwin");
  if (params?.launchJobLabel) {
    process.env.LAUNCH_JOB_LABEL = params.launchJobLabel;
  }
  process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
  const result = restartGatewayProcessWithFreshPid();
  expect(result.mode).toBe("supervised");
  if (params?.detailContains) {
    expect(result.detail).toContain(params.detailContains);
  }
  expect(scheduleDetachedLaunchdRestartHandoffMock).toHaveBeenCalledWith({
    env: process.env,
    mode: "start-after-exit",
    waitForPid: process.pid,
  });
  expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
}

describe("restartGatewayProcessWithFreshPid", () => {
  it("returns disabled when OPENCLAW_NO_RESPAWN is set", () => {
    process.env.OPENCLAW_NO_RESPAWN = "1";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("disabled");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when launchd hints are present on macOS (no kickstart)", () => {
    clearSupervisorHints();
    expectLaunchdSupervisedWithoutKickstart({
      launchJobLabel: "ai.openclaw.gateway",
      detailContains: "launchd restart handoff",
    });
  });

  it("returns supervised on macOS when launchd label is set (no kickstart)", () => {
    expectLaunchdSupervisedWithoutKickstart({ launchJobLabel: "ai.openclaw.gateway" });
  });

  it("launchd supervisor never returns failed regardless of triggerOpenClawRestart outcome", () => {
    clearSupervisorHints();
    setPlatform("darwin");
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    // Even if triggerOpenClawRestart *would* fail, launchd path must not call it.
    triggerOpenClawRestartMock.mockReturnValue({
      ok: false,
      method: "launchctl",
      detail: "Bootstrap failed: 5: Input/output error",
    });
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(result.mode).not.toBe("failed");
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
  });

  it("falls back to plain supervised exit when launchd handoff scheduling fails", () => {
    clearSupervisorHints();
    setPlatform("darwin");
    process.env.XPC_SERVICE_NAME = "ai.openclaw.gateway";
    scheduleDetachedLaunchdRestartHandoffMock.mockReturnValue({
      ok: false,
      detail: "spawn failed",
    });

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({
      mode: "supervised",
      detail: "launchd exit fallback (spawn failed)",
    });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not schedule kickstart on non-darwin platforms", () => {
    setPlatform("linux");
    process.env.INVOCATION_ID = "abc123";
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";

    const result = restartGatewayProcessWithFreshPid();

    expect(result.mode).toBe("supervised");
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when XPC_SERVICE_NAME is set by launchd", () => {
    clearSupervisorHints();
    setPlatform("darwin");
    process.env.XPC_SERVICE_NAME = "ai.openclaw.gateway";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
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

  it("respawns via stable wrapper when a package root is known", () => {
    delete process.env.OPENCLAW_NO_RESPAWN;
    clearSupervisorHints();
    setPlatform("linux");
    const rootPath = path.join(path.parse(process.cwd()).root, "opt", "openclaw");
    const wrapperPath = path.join(rootPath, "openclaw.mjs");
    process.execArgv = ["--trace-warnings"];
    process.argv = [
      "/usr/local/bin/node",
      path.join(rootPath, "dist", "entry.js"),
      "gateway",
      "--port",
      "45123",
    ];
    resolveOpenClawPackageRootSyncMock.mockReturnValue(rootPath);
    existsSyncMock.mockImplementation((value: unknown) => value === wrapperPath);
    spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({ mode: "spawned", pid: 4242 });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["--trace-warnings", wrapperPath, "gateway", "--port", "45123"],
      expect.objectContaining({
        detached: true,
        stdio: "inherit",
      }),
    );
  });

  it("rewrites pnpm versioned paths to the stable node_modules/openclaw wrapper", () => {
    delete process.env.OPENCLAW_NO_RESPAWN;
    clearSupervisorHints();
    setPlatform("linux");
    const srvRoot = path.join(path.parse(process.cwd()).root, "srv");
    const stableWrapperPath = path.join(srvRoot, "node_modules", "openclaw", "openclaw.mjs");
    process.execArgv = [];
    process.argv = [
      "/usr/local/bin/node",
      path.join(
        srvRoot,
        "node_modules",
        ".pnpm",
        "openclaw@2026.3.14",
        "node_modules",
        "openclaw",
        "dist",
        "entry.js",
      ),
      "gateway",
      "run",
    ];
    existsSyncMock.mockImplementation((value: unknown) => value === stableWrapperPath);
    spawnMock.mockReturnValue({ pid: 5150, unref: vi.fn() });

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({ mode: "spawned", pid: 5150 });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [stableWrapperPath, "gateway", "run"],
      expect.objectContaining({
        detached: true,
        stdio: "inherit",
      }),
    );
    expect(resolveOpenClawPackageRootSyncMock).not.toHaveBeenCalled();
  });

  it("keeps dev TypeScript entrypoints unchanged", () => {
    delete process.env.OPENCLAW_NO_RESPAWN;
    clearSupervisorHints();
    setPlatform("linux");
    process.execArgv = ["--import", "tsx"];
    process.argv = ["/usr/local/bin/node", "/repo/src/entry.ts", "gateway", "run"];
    spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({ mode: "spawned", pid: 4242 });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["--import", "tsx", "/repo/src/entry.ts", "gateway", "run"],
      expect.objectContaining({
        detached: true,
        stdio: "inherit",
      }),
    );
    expect(resolveOpenClawPackageRootSyncMock).not.toHaveBeenCalled();
  });

  it("keeps Bun-packaged gateways on a stable dist entrypoint instead of openclaw.mjs", () => {
    delete process.env.OPENCLAW_NO_RESPAWN;
    clearSupervisorHints();
    setPlatform("linux");
    if (originalExecPathDescriptor) {
      Object.defineProperty(process, "execPath", {
        ...originalExecPathDescriptor,
        value: "/usr/local/bin/bun",
      });
    }
    const rootPath = path.join(path.parse(process.cwd()).root, "opt", "openclaw");
    const stableDistEntrypoint = path.join(rootPath, "dist", "entry.js");
    process.execArgv = [];
    process.argv = ["/usr/local/bin/bun", stableDistEntrypoint, "gateway", "run"];
    resolveOpenClawPackageRootSyncMock.mockReturnValue(rootPath);
    existsSyncMock.mockImplementation((value: unknown) => value === stableDistEntrypoint);
    spawnMock.mockReturnValue({ pid: 6262, unref: vi.fn() });

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({ mode: "spawned", pid: 6262 });
    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/bun",
      [stableDistEntrypoint, "gateway", "run"],
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
    triggerOpenClawRestartMock.mockReturnValue({ ok: true, method: "schtasks" });
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(triggerOpenClawRestartMock).toHaveBeenCalledOnce();
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
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
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
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
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
