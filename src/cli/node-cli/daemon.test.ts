import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  buildNodeInstallPlan: vi.fn(),
  loadNodeHostConfig: vi.fn(),
  resolveOpenClawRuntimePath: vi.fn(),
  resolveOpenClawRuntimePathKind: vi.fn(),
  installDaemonServiceAndEmit: vi.fn(),
  parsePort: vi.fn(),
  service: {
    label: "Node",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    isLoaded: vi.fn(),
    install: vi.fn(),
    readCommand: vi.fn(),
  },
  actionState: {
    warnings: [] as string[],
    emitted: [] as unknown[],
    failed: [] as Array<{ message: string; hints?: string[] }>,
  },
}));

vi.mock("../../commands/node-daemon-install-helpers.js", () => ({
  buildNodeInstallPlan: mocks.buildNodeInstallPlan,
}));

vi.mock("../../commands/node-daemon-runtime.js", () => ({
  DEFAULT_NODE_DAEMON_RUNTIME: "node",
  isNodeDaemonRuntime: (value: string | undefined) => value === "node" || value === "bun",
}));

vi.mock("../../daemon/node-service.js", () => ({
  resolveNodeService: () => mocks.service,
}));

vi.mock("../../daemon/program-args.js", () => ({
  OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY: "OPENCLAW_DAEMON_RUNTIME_PATH",
  resolveOpenClawRuntimePath: mocks.resolveOpenClawRuntimePath,
  resolveOpenClawRuntimePathKind: mocks.resolveOpenClawRuntimePathKind,
}));

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    writeJson: vi.fn(),
  },
}));

vi.mock("../daemon-cli/response.js", () => ({
  buildDaemonServiceSnapshot: vi.fn(() => ({})),
  installDaemonServiceAndEmit: mocks.installDaemonServiceAndEmit,
}));

vi.mock("../daemon-cli/shared.js", () => ({
  createCliStatusTextStyles: vi.fn(() => ({
    label: (value: string) => value,
    accent: (value: string) => value,
    infoText: (value: string) => value,
    okText: (value: string) => value,
    warnText: (value: string) => value,
    errorText: (value: string) => value,
  })),
  createDaemonInstallActionContext: (jsonFlag: unknown) => ({
    json: Boolean(jsonFlag),
    stdout: process.stdout,
    warnings: mocks.actionState.warnings,
    emit: (payload: unknown) => {
      mocks.actionState.emitted.push(payload);
    },
    fail: (message: string, hints?: string[]) => {
      mocks.actionState.failed.push({ message, hints });
    },
  }),
  failIfNixDaemonInstallMode: vi.fn(() => false),
  formatRuntimeStatus: vi.fn((value: string) => value),
  parsePort: mocks.parsePort,
  resolveRuntimeStatusColor: vi.fn(() => "ok"),
}));

vi.mock("../error-format.js", () => ({
  formatInvalidConfigPort: (path: string) => `Invalid config port: ${path}`,
  formatInvalidPortOption: (option: string) => `Invalid port option: ${option}`,
}));

import { runNodeDaemonInstall } from "./daemon.js";

const envSnapshot = captureFullEnv();

afterEach(() => {
  envSnapshot.restore();
  vi.resetAllMocks();
  mocks.actionState.warnings.length = 0;
  mocks.actionState.emitted.length = 0;
  mocks.actionState.failed.length = 0;
});

beforeEach(() => {
  delete process.env.OPENCLAW_DAEMON_RUNTIME_PATH;
  mocks.loadNodeHostConfig.mockResolvedValue({ gateway: {} });
  mocks.parsePort.mockReturnValue(null);
  mocks.service.isLoaded.mockResolvedValue(false);
  mocks.service.readCommand.mockResolvedValue(null);
  mocks.installDaemonServiceAndEmit.mockImplementation(async ({ install }) => {
    await install();
  });
  mocks.resolveOpenClawRuntimePath.mockImplementation(
    async (value: string | undefined, runtime: string) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return undefined;
      }
      const kind = trimmed.endsWith("/bun") ? "bun" : "node";
      if (runtime !== "auto" && runtime !== kind) {
        throw new Error("runtime kind mismatch");
      }
      return trimmed;
    },
  );
  mocks.resolveOpenClawRuntimePathKind.mockImplementation((value: string) =>
    value.endsWith("/bun") ? "bun" : value.endsWith("/node") ? "node" : undefined,
  );
  mocks.buildNodeInstallPlan.mockResolvedValue({
    programArguments: ["node", "node-host"],
    workingDirectory: "/tmp/openclaw-node",
    environment: {},
    description: "OpenClaw Node",
  });
});

function readFirstBuildNodeInstallPlanArg(): Record<string, unknown> {
  const [firstArg] = mocks.buildNodeInstallPlan.mock.calls[0] ?? [];
  if (!firstArg || typeof firstArg !== "object") {
    throw new Error("Expected buildNodeInstallPlan call");
  }
  return firstArg as Record<string, unknown>;
}

describe("runNodeDaemonInstall", () => {
  it("preserves runtime path env from an installed node service during forced reinstall", async () => {
    const runtimePath = "/Users/me/.local/share/mise/installs/node/24.14.0/bin/node";
    mocks.service.readCommand.mockResolvedValue({
      programArguments: [runtimePath, "node-host"],
      environment: {
        OPENCLAW_DAEMON_RUNTIME_PATH: runtimePath,
      },
    });

    await runNodeDaemonInstall({ json: true, force: true });

    const installPlanArg = readFirstBuildNodeInstallPlanArg();
    expect(installPlanArg.runtime).toBe("node");
    expect(installPlanArg.runtimePath).toBe(runtimePath);
    expect(installPlanArg.env).toMatchObject({
      OPENCLAW_DAEMON_RUNTIME_PATH: runtimePath,
    });
    expect(mocks.service.install).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_DAEMON_RUNTIME_PATH: runtimePath,
        }),
      }),
    );
  });

  it("infers bun runtime from preserved runtime path env during forced reinstall", async () => {
    const runtimePath = "/Users/me/.bun/bin/bun";
    mocks.service.readCommand.mockResolvedValue({
      programArguments: [runtimePath, "node-host"],
      environment: {
        OPENCLAW_DAEMON_RUNTIME_PATH: runtimePath,
      },
    });

    await runNodeDaemonInstall({ json: true, force: true });

    const installPlanArg = readFirstBuildNodeInstallPlanArg();
    expect(installPlanArg.runtime).toBe("bun");
    expect(installPlanArg.runtimePath).toBe(runtimePath);
    expect(installPlanArg.env).toMatchObject({
      OPENCLAW_DAEMON_RUNTIME_PATH: runtimePath,
    });
  });

  it("lets explicit runtime selection replace a preserved runtime path during forced reinstall", async () => {
    mocks.service.readCommand.mockResolvedValue({
      programArguments: ["/Users/me/.bun/bin/bun", "node-host"],
      environment: {
        OPENCLAW_DAEMON_RUNTIME_PATH: "/Users/me/.bun/bin/bun",
      },
    });

    await runNodeDaemonInstall({ json: true, force: true, runtime: "node" });

    const installPlanArg = readFirstBuildNodeInstallPlanArg();
    expect(installPlanArg.runtime).toBe("node");
    expect(installPlanArg.runtimePath).toBeUndefined();
    expect(installPlanArg.env).not.toHaveProperty("OPENCLAW_DAEMON_RUNTIME_PATH");
  });
});
