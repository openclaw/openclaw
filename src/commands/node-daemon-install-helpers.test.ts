import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePreferredNodePath: vi.fn(),
  resolveNodeProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildNodeServiceEnvironment: vi.fn(),
  resolveOpenClawRuntimePath: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

vi.mock("../daemon/program-args.js", () => ({
  OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY: "OPENCLAW_DAEMON_RUNTIME_PATH",
  resolveNodeProgramArguments: mocks.resolveNodeProgramArguments,
  resolveOpenClawRuntimePath: mocks.resolveOpenClawRuntimePath,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildNodeServiceEnvironment: mocks.buildNodeServiceEnvironment,
}));

import { buildNodeInstallPlan } from "./node-daemon-install-helpers.js";

afterEach(() => {
  vi.resetAllMocks();
});

function mockRuntimePlanFixture() {
  mocks.resolveOpenClawRuntimePath.mockImplementation(async (value: string | undefined) =>
    value?.trim() ? value.trim() : undefined,
  );
  mocks.resolveNodeProgramArguments.mockResolvedValue({
    programArguments: ["node", "node-host"],
    workingDirectory: "/Users/me",
  });
  mocks.resolveSystemNodeInfo.mockResolvedValue({
    path: "/opt/node/bin/node",
    version: "22.0.0",
    supported: true,
  });
  mocks.renderSystemNodeWarning.mockReturnValue(undefined);
  mocks.buildNodeServiceEnvironment.mockReturnValue({
    OPENCLAW_SERVICE_VERSION: "2026.3.22",
  });
}

describe("buildNodeInstallPlan", () => {
  it("passes the selected runtime bin directory into the node service environment", async () => {
    mockRuntimePlanFixture();

    const plan = await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
      runtimePath: "/custom/node/bin/node",
    });

    expect(plan.environment).toEqual({
      OPENCLAW_SERVICE_VERSION: "2026.3.22",
    });
    expect(plan.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
    });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.buildNodeServiceEnvironment).toHaveBeenCalledWith({
      env: {
        OPENCLAW_DAEMON_RUNTIME_PATH: "/custom/node/bin/node",
      },
      extraPathDirs: ["/custom/node/bin"],
    });
    expect(mocks.resolveNodeProgramArguments).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePath: "/custom/node/bin/node",
      }),
    );
  });

  it("does not prepend '.' when nodePath is a bare legacy executable name", async () => {
    mockRuntimePlanFixture();

    await buildNodeInstallPlan({
      env: {},
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
      nodePath: "node",
    });

    expect(mocks.buildNodeServiceEnvironment).toHaveBeenCalledWith({
      env: {},
      extraPathDirs: undefined,
    });
    expect(mocks.resolveNodeProgramArguments).toHaveBeenCalledWith(
      expect.objectContaining({
        nodePath: "node",
        runtimePath: undefined,
      }),
    );
  });

  it("marks node gateway tokens as file-backed service env", async () => {
    mocks.resolveNodeProgramArguments.mockResolvedValue({
      programArguments: ["node", "node-host"],
      workingDirectory: "/Users/me",
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/usr/bin/node",
      version: "22.0.0",
      supported: true,
    });
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.buildNodeServiceEnvironment.mockReturnValue({
      OPENCLAW_GATEWAY_TOKEN: "node-token",
      OPENCLAW_SERVICE_VERSION: "2026.3.22",
    });

    const plan = await buildNodeInstallPlan({
      env: { OPENCLAW_GATEWAY_TOKEN: "node-token" },
      host: "127.0.0.1",
      port: 18789,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_GATEWAY_TOKEN).toBe("node-token");
    expect(plan.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
    });
  });
});
