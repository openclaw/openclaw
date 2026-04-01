import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const promptMocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  })),
}));

const workspaceSeedMocks = vi.hoisted(() => ({
  discoverWorkspaceDirs: vi.fn((stateDir: string) => [`${stateDir}/workspace`]),
  syncManagedSkills: vi.fn(() => ({
    syncedSkills: ["crm", "app-builder", "gstack"],
    workspaceDirs: ["/tmp/.openclaw-dench/workspace"],
    identityUpdated: false,
  })),
}));

const spawnMock = vi.hoisted(() => vi.fn());
const webRuntimeMocks = vi.hoisted(() => ({
  DEFAULT_WEB_APP_PORT: 3100,
  cleanupManagedWebRuntimeBackup: vi.fn(),
  ensureManagedWebRuntime: vi.fn(async () => ({ ready: true, reason: "ready" })),
  evaluateMajorVersionTransition: vi.fn(() => ({
    previousMajor: 2,
    currentMajor: 2,
    isMajorTransition: false,
  })),
  readLastKnownWebPort: vi.fn(() => 3100),
  readManagedWebRuntimeManifest: vi.fn(() => ({
    schemaVersion: 1,
    deployedDenchVersion: "2.1.0",
    deployedAt: "2026-01-01T00:00:00.000Z",
    sourceStandaloneServer: "/tmp/server.js",
    lastPort: 3100,
    lastGatewayPort: 19001,
  })),
  resolveCliPackageRoot: vi.fn(() => "/tmp/pkg"),
  resolveManagedWebRuntimeServerPath: vi.fn(() => "/tmp/.openclaw-dench/web-runtime/app/server.js"),
  resolveOpenClawCommandOrThrow: vi.fn(() => "/usr/local/bin/openclaw"),
  resolveProfileStateDir: vi.fn(() => "/tmp/.openclaw-dench"),
  runOpenClawCommand: vi.fn(async () => ({ code: 0, stdout: '{"ok":true}', stderr: "" })),
  startManagedWebRuntime: vi.fn(() => ({
    started: true,
    pid: 7788,
    runtimeServerPath: "/tmp/.openclaw-dench/web-runtime/app/server.js",
  })),
  stopManagedWebRuntime: vi.fn(async () => ({
    port: 3100,
    stoppedPids: [1234],
    skippedForeignPids: [],
  })),
  waitForWebRuntime: vi.fn(async () => ({ ok: true, reason: "profiles payload shape is valid" })),
}));

vi.mock("@clack/prompts", () => ({
  confirm: promptMocks.confirm,
  isCancel: promptMocks.isCancel,
  spinner: promptMocks.spinner,
}));

vi.mock("./workspace-seed.js", () => ({
  discoverWorkspaceDirs: workspaceSeedMocks.discoverWorkspaceDirs,
  syncManagedSkills: workspaceSeedMocks.syncManagedSkills,
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const launchdMocks = vi.hoisted(() => ({
  installWebRuntimeLaunchAgent: vi.fn(() => ({
    started: true,
    pid: 7788,
    runtimeServerPath: "/tmp/.openclaw-dench/web-runtime/app/server.js",
  })),
  uninstallWebRuntimeLaunchAgent: vi.fn(),
}));

vi.mock("./web-runtime-launchd.js", () => ({
  installWebRuntimeLaunchAgent: launchdMocks.installWebRuntimeLaunchAgent,
  uninstallWebRuntimeLaunchAgent: launchdMocks.uninstallWebRuntimeLaunchAgent,
}));

vi.mock("./web-runtime.js", () => ({
  DEFAULT_WEB_APP_PORT: webRuntimeMocks.DEFAULT_WEB_APP_PORT,
  ensureManagedWebRuntime: webRuntimeMocks.ensureManagedWebRuntime,
  evaluateMajorVersionTransition: webRuntimeMocks.evaluateMajorVersionTransition,
  readLastKnownWebPort: webRuntimeMocks.readLastKnownWebPort,
  readManagedWebRuntimeManifest: webRuntimeMocks.readManagedWebRuntimeManifest,
  resolveCliPackageRoot: webRuntimeMocks.resolveCliPackageRoot,
  resolveManagedWebRuntimeServerPath: webRuntimeMocks.resolveManagedWebRuntimeServerPath,
  resolveOpenClawCommandOrThrow: webRuntimeMocks.resolveOpenClawCommandOrThrow,
  resolveProfileStateDir: webRuntimeMocks.resolveProfileStateDir,
  runOpenClawCommand: webRuntimeMocks.runOpenClawCommand,
  startManagedWebRuntime: webRuntimeMocks.startManagedWebRuntime,
  stopManagedWebRuntime: webRuntimeMocks.stopManagedWebRuntime,
  waitForWebRuntime: webRuntimeMocks.waitForWebRuntime,
  cleanupManagedWebRuntimeBackup: webRuntimeMocks.cleanupManagedWebRuntimeBackup,
  readLastLogLines: vi.fn(() => undefined),
}));

import {
  restartWebRuntimeCommand,
  startWebRuntimeCommand,
  stopWebRuntimeCommand,
  updateWebRuntimeCommand,
} from "./web-runtime-command.js";

function createMockChild(code = 0): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.emit("close", code);
  });
  return child;
}

function runtimeStub(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("updateWebRuntimeCommand", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockChild(0));
    promptMocks.confirm.mockReset();
    promptMocks.confirm.mockImplementation(async () => true);
    promptMocks.isCancel.mockReset();
    promptMocks.isCancel.mockImplementation(() => false);

    launchdMocks.installWebRuntimeLaunchAgent.mockReset();
    launchdMocks.installWebRuntimeLaunchAgent.mockReturnValue({
      started: true,
      pid: 7788,
      runtimeServerPath: "/tmp/.openclaw-dench/web-runtime/app/server.js",
    });
    launchdMocks.uninstallWebRuntimeLaunchAgent.mockReset();

    workspaceSeedMocks.discoverWorkspaceDirs.mockReset();
    workspaceSeedMocks.discoverWorkspaceDirs.mockReturnValue(["/tmp/.openclaw-dench/workspace"]);
    workspaceSeedMocks.syncManagedSkills.mockReset();
    workspaceSeedMocks.syncManagedSkills.mockReturnValue({
      syncedSkills: ["crm", "app-builder", "gstack"],
      workspaceDirs: ["/tmp/.openclaw-dench/workspace"],
      identityUpdated: false,
    });

    webRuntimeMocks.ensureManagedWebRuntime.mockReset();
    webRuntimeMocks.ensureManagedWebRuntime.mockImplementation(
      async () => ({ ready: true, reason: "ready" }) as { ready: boolean; reason: string },
    );
    webRuntimeMocks.stopManagedWebRuntime.mockReset();
    webRuntimeMocks.stopManagedWebRuntime.mockImplementation(
      async () =>
        ({
          port: 3100,
          stoppedPids: [1234],
          skippedForeignPids: [],
        }) as { port: number; stoppedPids: number[]; skippedForeignPids: number[] },
    );
    webRuntimeMocks.evaluateMajorVersionTransition.mockReset();
    webRuntimeMocks.evaluateMajorVersionTransition.mockImplementation(() => ({
      previousMajor: 2,
      currentMajor: 2,
      isMajorTransition: false,
    }));
    webRuntimeMocks.readManagedWebRuntimeManifest.mockReset();
    webRuntimeMocks.readManagedWebRuntimeManifest.mockImplementation(() => ({
      schemaVersion: 1,
      deployedDenchVersion: "2.1.0",
      deployedAt: "2026-01-01T00:00:00.000Z",
      sourceStandaloneServer: "/tmp/server.js",
      lastPort: 3100,
      lastGatewayPort: 19001,
    }));
    webRuntimeMocks.startManagedWebRuntime.mockReset();
    webRuntimeMocks.startManagedWebRuntime.mockImplementation(() => ({
      started: true,
      pid: 7788,
      runtimeServerPath: "/tmp/.openclaw-dench/web-runtime/app/server.js",
    }));
    webRuntimeMocks.waitForWebRuntime.mockReset();
    webRuntimeMocks.waitForWebRuntime.mockImplementation(
      async () =>
        ({ ok: true, reason: "profiles payload shape is valid" }) as {
          ok: boolean;
          reason: string;
        },
    );
  });

  it("fails closed in non-interactive major upgrades without explicit approval (enforces mandatory operator consent)", async () => {
    webRuntimeMocks.evaluateMajorVersionTransition.mockReturnValue({
      previousMajor: 2,
      currentMajor: 3,
      isMajorTransition: true,
    });
    const runtime = runtimeStub();

    await expect(
      updateWebRuntimeCommand(
        {
          nonInteractive: true,
          yes: false,
        },
        runtime,
      ),
    ).rejects.toThrow("Major Dench upgrade detected");

    expect(spawnMock).not.toHaveBeenCalled();
    expect(webRuntimeMocks.ensureManagedWebRuntime).not.toHaveBeenCalled();
  });

  it("runs OpenClaw update before refreshing web runtime on major transitions (protects upgrade compatibility)", async () => {
    webRuntimeMocks.evaluateMajorVersionTransition.mockReturnValue({
      previousMajor: 2,
      currentMajor: 3,
      isMajorTransition: true,
    });
    const runtime = runtimeStub();

    const summary = await updateWebRuntimeCommand(
      {
        nonInteractive: true,
        yes: true,
      },
      runtime,
    );

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw",
      ["update", "--yes"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(webRuntimeMocks.ensureManagedWebRuntime).toHaveBeenCalled();
    expect(summary.majorGate.required).toBe(true);
  });

  it("syncs managed skills during update and includes result in summary", async () => {
    const runtime = runtimeStub();

    const summary = await updateWebRuntimeCommand(
      { nonInteractive: true },
      runtime,
    );

    expect(workspaceSeedMocks.discoverWorkspaceDirs).toHaveBeenCalledWith("/tmp/.openclaw-dench");
    expect(workspaceSeedMocks.syncManagedSkills).toHaveBeenCalledWith({
      workspaceDirs: ["/tmp/.openclaw-dench/workspace"],
      packageRoot: "/tmp/pkg",
    });
    expect(summary.skillSync).toEqual({
      syncedSkills: ["crm", "app-builder", "gstack"],
      workspaceDirs: ["/tmp/.openclaw-dench/workspace"],
      identityUpdated: false,
    });
  });

  it("skips gateway daemon restart and LaunchAgent in daemonless mode", async () => {
    webRuntimeMocks.runOpenClawCommand.mockClear();
    launchdMocks.uninstallWebRuntimeLaunchAgent.mockClear();
    const runtime = runtimeStub();
    const summary = await updateWebRuntimeCommand(
      { nonInteractive: true, skipDaemonInstall: true },
      runtime,
    );

    expect(webRuntimeMocks.runOpenClawCommand).not.toHaveBeenCalled();
    expect(launchdMocks.uninstallWebRuntimeLaunchAgent).not.toHaveBeenCalled();
    expect(summary.gatewayRestarted).toBe(false);
    expect(summary.gatewayError).toBeUndefined();
    expect(summary.ready).toBe(true);
  });

  it("skips OpenClaw update on minor upgrades while still refreshing runtime (avoids unnecessary blocking)", async () => {
    webRuntimeMocks.evaluateMajorVersionTransition.mockReturnValue({
      previousMajor: 2,
      currentMajor: 2,
      isMajorTransition: false,
    });
    const runtime = runtimeStub();

    const summary = await updateWebRuntimeCommand(
      {
        nonInteractive: true,
      },
      runtime,
    );

    expect(spawnMock).not.toHaveBeenCalled();
    expect(webRuntimeMocks.stopManagedWebRuntime).toHaveBeenCalledWith({
      stateDir: "/tmp/.openclaw-dench",
      port: 3100,
      includeLegacyStandalone: true,
    });
    expect(webRuntimeMocks.ensureManagedWebRuntime).toHaveBeenCalled();
    expect(summary.ready).toBe(true);
  });
});

describe("stopWebRuntimeCommand", () => {
  it("reports foreign listeners without terminating them (preserves process boundaries)", async () => {
    webRuntimeMocks.stopManagedWebRuntime.mockResolvedValue({
      port: 3100,
      stoppedPids: [],
      skippedForeignPids: [91, 92],
    });
    const runtime = runtimeStub();

    const summary = await stopWebRuntimeCommand(
      {
        webPort: "3100",
      },
      runtime,
    );

    expect(summary.stoppedPids).toEqual([]);
    expect(summary.skippedForeignPids).toEqual([91, 92]);
  });
});

describe("startWebRuntimeCommand", () => {
  beforeEach(() => {
    webRuntimeMocks.ensureManagedWebRuntime.mockClear();
    webRuntimeMocks.stopManagedWebRuntime.mockReset();
    webRuntimeMocks.stopManagedWebRuntime.mockImplementation(
      async () =>
        ({
          port: 3100,
          stoppedPids: [1234],
          skippedForeignPids: [],
        }) as { port: number; stoppedPids: number[]; skippedForeignPids: number[] },
    );
    webRuntimeMocks.startManagedWebRuntime.mockReset();
    webRuntimeMocks.startManagedWebRuntime.mockImplementation(() => ({
      started: true,
      pid: 7788,
      runtimeServerPath: "/tmp/.openclaw-dench/web-runtime/app/server.js",
    }));
    webRuntimeMocks.waitForWebRuntime.mockReset();
    webRuntimeMocks.waitForWebRuntime.mockImplementation(
      async () =>
        ({ ok: true, reason: "profiles payload shape is valid" }) as {
          ok: boolean;
          reason: string;
        },
    );
    launchdMocks.installWebRuntimeLaunchAgent.mockReset();
    launchdMocks.installWebRuntimeLaunchAgent.mockReturnValue({
      started: true,
      pid: 7788,
      runtimeServerPath: "/tmp/.openclaw-dench/web-runtime/app/server.js",
    });
    launchdMocks.uninstallWebRuntimeLaunchAgent.mockReset();
  });

  it("fails closed when non-dench listeners still own the port (prevents cross-process takeover)", async () => {
    webRuntimeMocks.stopManagedWebRuntime.mockResolvedValue({
      port: 3100,
      stoppedPids: [],
      skippedForeignPids: [9912],
    });
    const runtime = runtimeStub();

    await expect(startWebRuntimeCommand({}, runtime)).rejects.toThrow("non-Dench listener");
    expect(webRuntimeMocks.startManagedWebRuntime).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("fails with actionable remediation when managed runtime is missing (requires explicit update/bootstrap)", async () => {
    const missingResult = {
      started: false as const,
      runtimeServerPath: "/tmp/.openclaw-dench/web-runtime/app/server.js",
      reason: "runtime-missing",
    };
    webRuntimeMocks.startManagedWebRuntime.mockReturnValue(missingResult);
    launchdMocks.installWebRuntimeLaunchAgent.mockReturnValue(missingResult);
    const runtime = runtimeStub();

    await expect(startWebRuntimeCommand({}, runtime)).rejects.toThrow("npx denchclaw update");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("starts managed runtime without triggering update/install workflow (start-only behavior)", async () => {
    const runtime = runtimeStub();
    const summary = await startWebRuntimeCommand(
      {
        webPort: "3100",
      },
      runtime,
    );

    expect(webRuntimeMocks.stopManagedWebRuntime).toHaveBeenCalledWith({
      stateDir: "/tmp/.openclaw-dench",
      port: 3100,
      includeLegacyStandalone: true,
    });
    const startMock =
      process.platform === "darwin"
        ? launchdMocks.installWebRuntimeLaunchAgent
        : webRuntimeMocks.startManagedWebRuntime;
    expect(startMock).toHaveBeenCalledWith({
      stateDir: "/tmp/.openclaw-dench",
      port: 3100,
      gatewayPort: 19001,
    });
    expect(webRuntimeMocks.ensureManagedWebRuntime).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(summary.started).toBe(true);
  });

  it("skips gateway daemon restart and LaunchAgent in daemonless mode, uses child process", async () => {
    webRuntimeMocks.runOpenClawCommand.mockClear();
    launchdMocks.installWebRuntimeLaunchAgent.mockClear();
    launchdMocks.uninstallWebRuntimeLaunchAgent.mockClear();
    webRuntimeMocks.startManagedWebRuntime.mockClear();
    const runtime = runtimeStub();
    const summary = await startWebRuntimeCommand(
      { webPort: "3100", skipDaemonInstall: true },
      runtime,
    );

    expect(webRuntimeMocks.runOpenClawCommand).not.toHaveBeenCalled();
    expect(launchdMocks.installWebRuntimeLaunchAgent).not.toHaveBeenCalled();
    expect(launchdMocks.uninstallWebRuntimeLaunchAgent).not.toHaveBeenCalled();
    expect(webRuntimeMocks.startManagedWebRuntime).toHaveBeenCalledWith({
      stateDir: "/tmp/.openclaw-dench",
      port: 3100,
      gatewayPort: 19001,
    });
    expect(summary.started).toBe(true);
    expect(summary.gatewayRestarted).toBe(false);
    expect(summary.gatewayError).toBeUndefined();
  });

  it("falls back to DenchClaw port 19001 when manifest has no lastGatewayPort (prevents 18789 hijack)", async () => {
    webRuntimeMocks.readManagedWebRuntimeManifest.mockReturnValue({
      schemaVersion: 1,
      deployedDenchVersion: "2.1.0",
      deployedAt: "2026-01-01T00:00:00.000Z",
      sourceStandaloneServer: "/tmp/server.js",
      lastPort: 3100,
    });
    const runtime = runtimeStub();
    await startWebRuntimeCommand({ webPort: "3100" }, runtime);

    const startMock =
      process.platform === "darwin"
        ? launchdMocks.installWebRuntimeLaunchAgent
        : webRuntimeMocks.startManagedWebRuntime;
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 19001 }),
    );
  });

  it("falls back to DenchClaw port 19001 when manifest is null (fresh install, prevents 18789 hijack)", async () => {
    webRuntimeMocks.readManagedWebRuntimeManifest.mockReturnValue(null);
    const runtime = runtimeStub();
    await startWebRuntimeCommand({ webPort: "3100" }, runtime);

    const startMock =
      process.platform === "darwin"
        ? launchdMocks.installWebRuntimeLaunchAgent
        : webRuntimeMocks.startManagedWebRuntime;
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 19001 }),
    );
  });
});

describe("restartWebRuntimeCommand", () => {
  beforeEach(() => {
    webRuntimeMocks.ensureManagedWebRuntime.mockClear();
    webRuntimeMocks.stopManagedWebRuntime.mockReset();
    webRuntimeMocks.stopManagedWebRuntime.mockImplementation(
      async () =>
        ({
          port: 3100,
          stoppedPids: [1234],
          skippedForeignPids: [],
        }) as { port: number; stoppedPids: number[]; skippedForeignPids: number[] },
    );
    webRuntimeMocks.startManagedWebRuntime.mockReset();
    webRuntimeMocks.startManagedWebRuntime.mockImplementation(() => ({
      started: true,
      pid: 7788,
      runtimeServerPath: "/tmp/.openclaw-dench/web-runtime/app/server.js",
    }));
    webRuntimeMocks.waitForWebRuntime.mockReset();
    webRuntimeMocks.waitForWebRuntime.mockImplementation(
      async () =>
        ({ ok: true, reason: "profiles payload shape is valid" }) as {
          ok: boolean;
          reason: string;
        },
    );
    launchdMocks.installWebRuntimeLaunchAgent.mockReset();
    launchdMocks.installWebRuntimeLaunchAgent.mockReturnValue({
      started: true,
      pid: 7788,
      runtimeServerPath: "/tmp/.openclaw-dench/web-runtime/app/server.js",
    });
    launchdMocks.uninstallWebRuntimeLaunchAgent.mockReset();
  });

  it("stops and restarts managed runtime (same stop+start lifecycle as start command)", async () => {
    const runtime = runtimeStub();
    const summary = await restartWebRuntimeCommand(
      {
        webPort: "3100",
      },
      runtime,
    );

    expect(webRuntimeMocks.stopManagedWebRuntime).toHaveBeenCalledWith({
      stateDir: "/tmp/.openclaw-dench",
      port: 3100,
      includeLegacyStandalone: true,
    });
    const startMock =
      process.platform === "darwin"
        ? launchdMocks.installWebRuntimeLaunchAgent
        : webRuntimeMocks.startManagedWebRuntime;
    expect(startMock).toHaveBeenCalledWith({
      stateDir: "/tmp/.openclaw-dench",
      port: 3100,
      gatewayPort: 19001,
    });
    expect(webRuntimeMocks.ensureManagedWebRuntime).not.toHaveBeenCalled();
    expect(summary.started).toBe(true);
  });

  it("outputs restart heading instead of start (distinct user-facing label)", async () => {
    const runtime = runtimeStub();
    await restartWebRuntimeCommand({}, runtime);

    const logCalls = (runtime.log as ReturnType<typeof vi.fn>).mock.calls.map(
      ([msg]: [string]) => msg,
    );
    expect(logCalls.some((msg) => typeof msg === "string" && msg.includes("restart"))).toBe(true);
    expect(logCalls.some((msg) => typeof msg === "string" && /\bstart\b/.test(msg) && !msg.includes("restart"))).toBe(false);
  });
});
