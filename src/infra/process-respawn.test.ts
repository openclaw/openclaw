// Covers process respawn behavior across supervisors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatWindowsTaskSupervisorChildArgument,
  WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
} from "../daemon/windows-task-supervisor-contract.js";
import { captureFullEnv, deleteTestEnvValue } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";

const spawnMock = vi.hoisted(() => vi.fn());
const triggerOpenClawRestartMock = vi.hoisted(() => vi.fn());
const scheduleLaunchdHandoffMock = vi.hoisted(() =>
  vi.fn(
    (
      ..._args: unknown[]
    ): { ok: true; value: Promise<boolean> } | { ok: false; error: string } => ({
      ok: true,
      value: Promise.resolve(true),
    }),
  ),
);
const isContainerEnvironmentMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
    },
  );
});
vi.mock("./restart.js", () => ({
  triggerOpenClawRestart: (...args: unknown[]) => triggerOpenClawRestartMock(...args),
}));
vi.mock("../daemon/launchd-restart-handoff.js", () => ({
  scheduleDetachedLaunchdRestartHandoff: (...args: unknown[]) =>
    scheduleLaunchdHandoffMock(...args),
}));
vi.mock("./container-environment.js", () => ({
  isContainerEnvironment: () => isContainerEnvironmentMock(),
}));

import {
  respawnGatewayProcessForUpdate,
  restartGatewayProcessWithFreshPid,
} from "./process-respawn.js";

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const envSnapshot = captureFullEnv();

afterEach(() => {
  envSnapshot.restore();
  process.argv = [...originalArgv];
  process.execArgv = [...originalExecArgv];
  spawnMock.mockClear();
  triggerOpenClawRestartMock.mockClear();
  scheduleLaunchdHandoffMock.mockReset();
  scheduleLaunchdHandoffMock.mockReturnValue({
    ok: true,
    value: Promise.resolve(true),
  });
  isContainerEnvironmentMock.mockReset();
  isContainerEnvironmentMock.mockReturnValue(false);
  vi.restoreAllMocks();
});

function clearSupervisorHints() {
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    deleteTestEnvValue(key);
  }
}

beforeEach(clearSupervisorHints);

function setupSupervisor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) {
  mockProcessPlatform(platform);
  Object.assign(process.env, env);
}

function setupWindowsGateway() {
  setupSupervisor("win32", {
    OPENCLAW_SERVICE_MARKER: "openclaw",
    OPENCLAW_SERVICE_KIND: "gateway",
  });
}

function mockDetachedChild(pid: number) {
  return { pid, kill: vi.fn(), on: vi.fn(), unref: vi.fn() };
}

function setupUpdate(platform: NodeJS.Platform, pid: number, entry = "/repo/dist/index.js") {
  setupSupervisor(platform);
  process.execArgv = [];
  process.argv = [
    platform === "win32" ? "C:\\Program Files\\node.exe" : "/usr/local/bin/node",
    entry,
    "gateway",
    "run",
  ];
  const child = mockDetachedChild(pid);
  spawnMock.mockReturnValue(child);
  return child;
}

describe("restartGatewayProcessWithFreshPid", () => {
  it("keeps OPENCLAW_NO_RESPAWN ahead of inherited supervisor hints", () => {
    setupSupervisor("darwin", {
      OPENCLAW_NO_RESPAWN: "1",
      LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
    });

    expect(restartGatewayProcessWithFreshPid()).toEqual({ mode: "disabled" });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "injected and real",
      { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway", LAUNCH_JOB_LABEL: "ai.openclaw.gateway" },
    ],
    ["injected only", { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }],
    ["real job only", { LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }],
    ["real XPC job only", { XPC_SERVICE_NAME: "ai.openclaw.gateway" }],
  ] as const)("schedules launchd handoff with %s markers", (_name, env) => {
    setupSupervisor("darwin", env);
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(result.handoffSpawned).toBeInstanceOf(Promise);
    expect(scheduleLaunchdHandoffMock).toHaveBeenCalledOnce();
    expect(scheduleLaunchdHandoffMock).toHaveBeenCalledWith({
      mode: "start-after-exit",
      waitForPid: process.pid,
    });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns failed when the launchd handoff cannot be scheduled", () => {
    setupSupervisor("darwin", { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" });
    scheduleLaunchdHandoffMock.mockReturnValue({ ok: false, error: "spawn EPERM" });

    expect(restartGatewayProcessWithFreshPid()).toEqual({
      mode: "failed",
      detail: "spawn EPERM",
    });
  });

  it("does not schedule kickstart on non-darwin platforms", () => {
    mockProcessPlatform("linux");
    process.env.INVOCATION_ID = "abc123";
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";

    const result = restartGatewayProcessWithFreshPid();

    expect(result.mode).toBe("supervised");
    expect(scheduleLaunchdHandoffMock).not.toHaveBeenCalled();
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "inherited XPC state",
      "darwin",
      { XPC_SERVICE_NAME: "ai.openclaw.mac", OPENCLAW_PROFILE: "mac" },
    ],
    ["unmanaged Unix", "linux", {}],
    [
      "generic service markers",
      "linux",
      { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
    ],
  ] as const)("keeps the tracked PID with %s", (name, platform, env) => {
    setupSupervisor(platform, env);
    if (name === "unmanaged Unix") {
      delete process.env.OPENCLAW_NO_RESPAWN;
      process.execArgv = ["--import", "tsx"];
      process.argv = ["/usr/local/bin/node", "/repo/dist/index.js", "gateway", "run"];
      spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });
    }
    expect(restartGatewayProcessWithFreshPid()).toEqual({
      mode: "disabled",
      detail: "unmanaged: use in-process restart to keep custom supervisor PID tracking stable",
    });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when OPENCLAW_SYSTEMD_UNIT is set", () => {
    setupSupervisor("linux", { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" });
    expect(restartGatewayProcessWithFreshPid().mode).toBe("supervised");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("exits to external supervision without invoking inherited native restart hooks", () => {
    setupSupervisor("win32", {
      OPENCLAW_SUPERVISOR_MODE: "external",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway",
    });

    expect(restartGatewayProcessWithFreshPid()).toEqual({ mode: "supervised" });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when OpenClaw gateway task markers are set on Windows", () => {
    setupWindowsGateway();
    triggerOpenClawRestartMock.mockReturnValue({ ok: true, method: "schtasks" });
    expect(restartGatewayProcessWithFreshPid().mode).toBe("supervised");
    expect(triggerOpenClawRestartMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns the task-supervisor restart code without launching a detached handoff", () => {
    setupWindowsGateway();
    process.argv = [...originalArgv, formatWindowsTaskSupervisorChildArgument(305419896)];

    expect(restartGatewayProcessWithFreshPid()).toEqual({
      mode: "supervised",
      exitCode: 305419896,
    });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects a task-supervisor child without its private restart marker", () => {
    setupWindowsGateway();
    process.argv = [...originalArgv, WINDOWS_TASK_SUPERVISOR_CHILD_FLAG];

    expect(restartGatewayProcessWithFreshPid()).toEqual({
      mode: "failed",
      detail: "Windows task supervisor restart marker is missing or invalid",
    });
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
  });

  it("returns disabled on Windows without Scheduled Task markers", () => {
    clearSupervisorHints();
    mockProcessPlatform("win32");

    const result = restartGatewayProcessWithFreshPid();

    expect(result.mode).toBe("disabled");
    expect(result.detail).toContain("Scheduled Task");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns disabled in containers so PID 1 stays alive for in-process restart", () => {
    delete process.env.OPENCLAW_NO_RESPAWN;
    setupSupervisor("linux");
    isContainerEnvironmentMock.mockReturnValue(true);

    expect(restartGatewayProcessWithFreshPid()).toEqual({
      mode: "disabled",
      detail: "container: use in-process restart to keep PID 1 alive",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("ignores node task script hints for gateway restart detection on Windows", () => {
    clearSupervisorHints();
    mockProcessPlatform("win32");
    process.env.OPENCLAW_TASK_SCRIPT = "C:\\openclaw\\node.cmd";
    process.env.OPENCLAW_TASK_SCRIPT_NAME = "node.cmd";
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "node";

    const result = restartGatewayProcessWithFreshPid();

    expect(result.mode).toBe("disabled");
    expect(triggerOpenClawRestartMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("respawnGatewayProcessForUpdate", () => {
  it("keeps OPENCLAW_NO_RESPAWN semantics for update restarts", () => {
    process.env.OPENCLAW_NO_RESPAWN = "1";

    expect(respawnGatewayProcessForUpdate()).toEqual({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Windows pnpm entry",
      "win32",
      5151,
      "C:\\openclaw\\node_modules\\.pnpm\\openclaw@2026.6.5\\node_modules\\openclaw\\dist\\index.js",
      "C:\\openclaw\\node_modules\\openclaw\\openclaw.mjs",
    ],
    [
      "Unix pnpm entry",
      "linux",
      7171,
      "/app/node_modules/.pnpm/openclaw@2026.6.5/node_modules/openclaw/dist/entry.js",
      "/app/node_modules/openclaw/openclaw.mjs",
    ],
    [
      "another package's pnpm entry",
      "linux",
      8181,
      "/app/node_modules/.pnpm/@anthropic+sdk@1.0.0/node_modules/@anthropic/sdk/dist/index.js",
      "/app/node_modules/.pnpm/@anthropic+sdk@1.0.0/node_modules/@anthropic/sdk/dist/index.js",
    ],
    ["inherited macOS XPC state", "darwin", 6161, "/repo/dist/index.js", "/repo/dist/index.js"],
  ] as const)("spawns a detached update with %s", (_name, platform, pid, entry, expectedEntry) => {
    setupUpdate(platform, pid, entry);
    if (platform === "darwin") {
      process.env.XPC_SERVICE_NAME = "ai.openclaw.mac";
    }
    expect(respawnGatewayProcessForUpdate()).toMatchObject({ mode: "spawned", pid });
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, [expectedEntry, "gateway", "run"], {
      detached: true,
      env: process.env,
      stdio: "inherit",
    });
  });

  it("registers a no-op detached child error listener before unref", () => {
    const child = setupUpdate("linux", 9191);

    const result = respawnGatewayProcessForUpdate();

    if (result.mode !== "spawned") {
      throw new Error("Expected a spawned update child");
    }
    expect(result.child).toBe(child);
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    const errorListener = child.on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(() => errorListener?.(new Error("spawn ENOENT"))).not.toThrow();
    expect(child.unref).toHaveBeenCalledOnce();
    const onCallOrder = child.on.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const unrefCallOrder = child.unref.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    expect(onCallOrder).toBeLessThan(unrefCallOrder);
  });

  it("returns failed when update detached respawn throws", () => {
    delete process.env.OPENCLAW_NO_RESPAWN;
    setupSupervisor("linux");

    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    expect(respawnGatewayProcessForUpdate()).toMatchObject({
      mode: "failed",
      detail: expect.stringContaining("spawn failed"),
    });
  });
});
