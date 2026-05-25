import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayServiceCommand } from "../../daemon/service.ts";
import type { NodeHostConfig } from "../../node-host/config.ts";
import { runNodeDaemonInstall, runNodeDaemonStatus } from "./daemon.js";

const actionState = vi.hoisted(() => ({
  warnings: [] as string[],
  emitted: [] as unknown[],
  failed: [] as Array<{ message: string; hints?: string[] }>,
}));

const mocks = vi.hoisted(() => {
  const service = {
    label: "Node service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: vi.fn(async () => true),
    readCommand: vi.fn<() => Promise<GatewayServiceCommand | null>>(async () => null),
    readRuntime: vi.fn<() => Promise<GatewayServiceRuntime>>(async () => ({ status: "running" })),
  };
  return {
    buildNodeInstallPlan: vi.fn(async () => ({
      programArguments: ["openclaw", "node", "run"],
      workingDirectory: "/tmp/openclaw-node",
      environment: {},
      environmentValueSources: {},
      description: "OpenClaw node host",
    })),
    loadNodeHostConfig: vi.fn<() => Promise<NodeHostConfig | null>>(async () => null),
    installDaemonServiceAndEmit: vi.fn(async (_params?: unknown) => {}),
    runtime: {
      log: vi.fn<(line: string) => void>(),
      error: vi.fn<(line: string) => void>(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    },
    service,
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../../daemon/node-service.js", () => ({
  resolveNodeService: () => mocks.service,
}));

vi.mock("../../commands/node-daemon-install-helpers.js", () => ({
  buildNodeInstallPlan: mocks.buildNodeInstallPlan,
}));

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));

vi.mock("../../daemon/runtime-hints.js", () => ({
  buildPlatformRuntimeLogHints: () => [
    "Logs: node service log",
    "Restart attempts: node restart log",
  ],
  buildPlatformServiceStartHints: () => ["openclaw node install", "openclaw node start"],
}));

vi.mock("../../terminal/theme.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../terminal/theme.js")>("../../terminal/theme.js");
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

vi.mock("../daemon-cli/shared.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon-cli/shared.js")>("../daemon-cli/shared.js");
  return {
    ...actual,
    createDaemonInstallActionContext: (jsonFlag: unknown) => {
      const json = Boolean(jsonFlag);
      return {
        json,
        stdout: process.stdout,
        warnings: actionState.warnings,
        emit: (payload: unknown) => {
          if (json) {
            actionState.emitted.push(payload);
          }
        },
        fail: (message: string, hints?: string[]) => {
          actionState.failed.push({ message, hints });
          mocks.runtime.exit(1);
        },
      };
    },
    createCliStatusTextStyles: () => ({
      rich: false,
      label: (text: string) => text,
      accent: (text: string) => text,
      infoText: (text: string) => text,
      okText: (text: string) => text,
      warnText: (text: string) => text,
      errorText: (text: string) => text,
    }),
    failIfNixDaemonInstallMode: () => false,
    formatRuntimeStatus: (runtime: GatewayServiceRuntime | undefined) => runtime?.status ?? "",
    resolveRuntimeStatusColor: () => "",
  };
});

vi.mock("../daemon-cli/response.js", async () => {
  const actual = await vi.importActual<typeof import("../daemon-cli/response.js")>(
    "../daemon-cli/response.js",
  );
  return {
    ...actual,
    installDaemonServiceAndEmit: mocks.installDaemonServiceAndEmit,
  };
});

describe("runNodeDaemonStatus", () => {
  function stdout(): string {
    return mocks.runtime.log.mock.calls.map(([line]) => line).join("\n");
  }

  function stderr(): string {
    return mocks.runtime.error.mock.calls.map(([line]) => line).join("\n");
  }

  beforeEach(() => {
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.buildNodeInstallPlan.mockClear();
    mocks.loadNodeHostConfig.mockReset().mockResolvedValue(null);
    mocks.installDaemonServiceAndEmit.mockReset().mockResolvedValue(undefined);
    mocks.service.isLoaded.mockReset().mockResolvedValue(true);
    mocks.service.readCommand.mockReset().mockResolvedValue(null);
    mocks.service.readRuntime.mockReset().mockResolvedValue({ status: "running" });
    actionState.warnings.length = 0;
    actionState.emitted.length = 0;
    actionState.failed.length = 0;
  });

  it("fails install when the saved node gateway port is invalid", async () => {
    mocks.loadNodeHostConfig.mockResolvedValue({
      version: 1,
      gateway: { port: 70_000 },
    });

    await runNodeDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("node.gateway.port");
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.service.isLoaded).not.toHaveBeenCalled();
    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
    expect(mocks.installDaemonServiceAndEmit).not.toHaveBeenCalled();
  });

  it("short-circuits install when the node service is already loaded", async () => {
    mocks.service.isLoaded.mockResolvedValue(true);

    await runNodeDaemonInstall({});

    expect(stdout()).toContain("Node service already loaded.");
    expect(stdout()).toContain("openclaw node install --force");
    expect(actionState.failed).toStrictEqual([]);
    expect(mocks.buildNodeInstallPlan).not.toHaveBeenCalled();
    expect(mocks.installDaemonServiceAndEmit).not.toHaveBeenCalled();
  });

  it("writes node service status as json when requested", async () => {
    mocks.service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "node", "run"],
      sourcePath: "/tmp/openclaw-node.service",
      workingDirectory: "/tmp/openclaw-node",
      environment: { OPENCLAW_PROFILE: "node-test" },
    });

    await runNodeDaemonStatus({ json: true });

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
      service: {
        label: "Node service",
        loaded: true,
        loadedText: "loaded",
        notLoadedText: "not loaded",
        command: {
          programArguments: ["openclaw", "node", "run"],
          sourcePath: "/tmp/openclaw-node.service",
          workingDirectory: "/tmp/openclaw-node",
          environment: { OPENCLAW_PROFILE: "node-test" },
        },
        runtime: { status: "running" },
      },
    });
    expect(stdout()).toBe("");
    expect(stderr()).toBe("");
  });

  it("prints node service start hints when the service is not installed", async () => {
    mocks.service.isLoaded.mockResolvedValue(false);
    mocks.service.readRuntime.mockResolvedValue({ status: "unknown" });

    await runNodeDaemonStatus();

    expect(stdout()).toContain("Start with: openclaw node install");
    expect(stdout()).toContain("Start with: openclaw node start");
    expect(stderr()).toBe("");
  });

  it("keeps missing service-unit status on stderr and prints recovery hints on stdout", async () => {
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped", missingUnit: true });

    await runNodeDaemonStatus();

    expect(stderr()).toContain("Service unit not found.");
    expect(stdout()).toContain("Logs: node service log");
    expect(stdout()).toContain("Restart attempts: node restart log");
    expect(stderr()).not.toContain("Logs: node service log");
    expect(stderr()).not.toContain("Restart attempts: node restart log");
  });

  it("keeps stopped status on stderr and prints recovery hints on stdout", async () => {
    mocks.service.readRuntime.mockResolvedValue({ status: "stopped" });

    await runNodeDaemonStatus();

    expect(stderr()).toContain("Service is loaded but not running.");
    expect(stdout()).toContain("Logs: node service log");
    expect(stdout()).toContain("Restart attempts: node restart log");
    expect(stderr()).not.toContain("Logs: node service log");
    expect(stderr()).not.toContain("Restart attempts: node restart log");
  });
});
