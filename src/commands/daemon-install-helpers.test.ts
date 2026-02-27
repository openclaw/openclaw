import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePreferredNodePath: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildServiceEnvironment: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: mocks.resolveGatewayProgramArguments,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildServiceEnvironment: mocks.buildServiceEnvironment,
}));

import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
  resolveGatewayDevMode,
} from "./daemon-install-helpers.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveGatewayDevMode", () => {
  it("detects dev mode for src ts entrypoints", () => {
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/src/cli/index.ts"])).toBe(true);
    expect(resolveGatewayDevMode(["node", "C:\\Users\\me\\openclaw\\src\\cli\\index.ts"])).toBe(
      true,
    );
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/dist/cli/index.js"])).toBe(false);
  });
});

function mockNodeGatewayPlanFixture(
  params: {
    workingDirectory?: string;
    version?: string;
    supported?: boolean;
    warning?: string;
    serviceEnvironment?: Record<string, string>;
  } = {},
) {
  const {
    workingDirectory = "/Users/me",
    version = "22.0.0",
    supported = true,
    warning,
    serviceEnvironment = { OPENCLAW_PORT: "3000" },
  } = params;
  mocks.resolvePreferredNodePath.mockResolvedValue("/opt/node");
  mocks.resolveGatewayProgramArguments.mockResolvedValue({
    programArguments: ["node", "gateway"],
    workingDirectory,
  });
  mocks.resolveSystemNodeInfo.mockResolvedValue({
    path: "/opt/node",
    version,
    supported,
  });
  mocks.renderSystemNodeWarning.mockReturnValue(warning);
  mocks.buildServiceEnvironment.mockReturnValue(serviceEnvironment);
}

describe("buildGatewayInstallPlan", () => {
  it("uses provided nodePath and returns plan", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      nodePath: "/custom/node",
    });

    expect(plan.programArguments).toEqual(["node", "gateway"]);
    expect(plan.workingDirectory).toBe("/Users/me");
    expect(plan.environment).toEqual({ OPENCLAW_PORT: "3000" });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
  });

  it("emits warnings when renderSystemNodeWarning returns one", async () => {
    const warn = vi.fn();
    mockNodeGatewayPlanFixture({
      workingDirectory: undefined,
      version: "18.0.0",
      supported: false,
      warning: "Node too old",
      serviceEnvironment: {},
    });

    await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(warn).toHaveBeenCalledWith("Node too old", "Gateway runtime");
    expect(mocks.resolvePreferredNodePath).toHaveBeenCalled();
  });

  it("merges config env vars into the environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
        HOME: "/Users/me",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            GOOGLE_API_KEY: "test-key",
          },
          CUSTOM_VAR: "custom-value",
        },
      },
    });

    // Config env vars should be present
    expect(plan.environment.GOOGLE_API_KEY).toBe("test-key");
    expect(plan.environment.CUSTOM_VAR).toBe("custom-value");
    // Service environment vars should take precedence
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
    expect(plan.environment.HOME).toBe("/Users/me");
  });

  it("drops dangerous config env vars before service merge", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            NODE_OPTIONS: "--require /tmp/evil.js",
            SAFE_KEY: "safe-value",
          },
        },
      },
    });

    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.SAFE_KEY).toBe("safe-value");
  });

  it("does not include empty config env values", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            VALID_KEY: "valid",
            EMPTY_KEY: "",
          },
        },
      },
    });

    expect(plan.environment.VALID_KEY).toBe("valid");
    expect(plan.environment.EMPTY_KEY).toBeUndefined();
  });

  it("drops whitespace-only config env values", async () => {
    mockNodeGatewayPlanFixture({ serviceEnvironment: {} });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            VALID_KEY: "valid",
          },
          TRIMMED_KEY: "  ",
        },
      },
    });

    expect(plan.environment.VALID_KEY).toBe("valid");
    expect(plan.environment.TRIMMED_KEY).toBeUndefined();
  });

  it("keeps service env values over config env vars", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/Users/service",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          HOME: "/Users/config",
          vars: {
            OPENCLAW_PORT: "9999",
          },
        },
      },
    });

    expect(plan.environment.HOME).toBe("/Users/service");
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
  });
});

describe("buildGatewayInstallPlan — launcher config", () => {
  let tmpDir: string;
  let launcherPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-launcher-test-"));
    launcherPath = path.join(tmpDir, "gateway-launcher.sh");
    fs.writeFileSync(launcherPath, "#!/bin/sh\nexec node gateway", { mode: 0o755 });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses custom launcher script as sole program argument when config.gateway.service.launcher is set", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        gateway: {
          service: {
            launcher: launcherPath,
          },
        },
      },
    });

    expect(plan.programArguments).toEqual([launcherPath]);
  });

  it("expands ~ in launcher path to home directory", async () => {
    // Create executable script in the real home directory temp location.
    const homeSubdir = path.join(os.homedir(), ".openclaw-test-launcher");
    const homeLauncher = path.join(homeSubdir, "launcher.sh");
    fs.mkdirSync(homeSubdir, { recursive: true });
    fs.writeFileSync(homeLauncher, "#!/bin/sh\nexec node gateway", { mode: 0o755 });

    try {
      mockNodeGatewayPlanFixture();

      const plan = await buildGatewayInstallPlan({
        env: {},
        port: 3000,
        runtime: "node",
        config: {
          gateway: {
            service: {
              launcher: "~/.openclaw-test-launcher/launcher.sh",
            },
          },
        },
      });

      expect(plan.programArguments).toHaveLength(1);
      // Verify tilde expansion happened (don't check for *any* ~, Windows 8.3 short names like RUNNER~1 contain ~).
      expect(plan.programArguments[0]).not.toMatch(/^~[/\\]/);
      expect(plan.programArguments[0]).toBe(homeLauncher);
    } finally {
      fs.rmSync(homeSubdir, { recursive: true, force: true });
    }
  });

  it("throws when launcher script does not exist", async () => {
    mockNodeGatewayPlanFixture();

    await expect(
      buildGatewayInstallPlan({
        env: {},
        port: 3000,
        runtime: "node",
        config: {
          gateway: {
            service: {
              launcher: "/nonexistent/path/launcher.sh",
            },
          },
        },
      }),
    ).rejects.toThrow("script not found");
  });

  it("throws when launcher path is relative", async () => {
    mockNodeGatewayPlanFixture();

    await expect(
      buildGatewayInstallPlan({
        env: {},
        port: 3000,
        runtime: "node",
        config: {
          gateway: {
            service: {
              launcher: "scripts/gateway-launcher.sh",
            },
          },
        },
      }),
    ).rejects.toThrow("path must be absolute or start with ~/");
  });

  // Windows does not enforce Unix-style executable permissions; fs.accessSync(X_OK) is a no-op.
  it.skipIf(process.platform === "win32")(
    "throws when launcher script is not executable",
    async () => {
      const nonExecPath = path.join(tmpDir, "not-executable.sh");
      fs.writeFileSync(nonExecPath, "#!/bin/sh\n", { mode: 0o644 });
      mockNodeGatewayPlanFixture();

      await expect(
        buildGatewayInstallPlan({
          env: {},
          port: 3000,
          runtime: "node",
          config: {
            gateway: {
              service: {
                launcher: nonExecPath,
              },
            },
          },
        }),
      ).rejects.toThrow("not executable");
    },
  );

  it("uses default program arguments when no launcher is configured", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
    });

    expect(plan.programArguments).toEqual(["node", "gateway"]);
  });

  it("passes entryPath to buildServiceEnvironment when program args contain a script file before gateway", async () => {
    mocks.resolvePreferredNodePath.mockResolvedValue("/opt/node");
    mocks.resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["/opt/node", "/Users/me/openclaw/dist/entry.js", "gateway"],
      workingDirectory: "/Users/me",
    });
    mocks.buildServiceEnvironment.mockReturnValue({ OPENCLAW_PORT: "3000" });

    await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
    });

    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPath: "/Users/me/openclaw/dist/entry.js",
      }),
    );
  });

  it("does not set entryPath when the arg before gateway is a binary, not a script", async () => {
    mocks.resolvePreferredNodePath.mockResolvedValue("/opt/bun");
    mocks.resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["/opt/homebrew/bin/bun", "gateway"],
      workingDirectory: "/Users/me",
    });
    mocks.buildServiceEnvironment.mockReturnValue({ OPENCLAW_PORT: "3000" });

    await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "bun",
    });

    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPath: undefined,
      }),
    );
  });
});

describe("gatewayInstallErrorHint", () => {
  it("returns platform-specific hints", () => {
    expect(gatewayInstallErrorHint("win32")).toContain("Run as administrator");
    expect(gatewayInstallErrorHint("linux")).toMatch(
      /(?:openclaw|openclaw)( --profile isolated)? gateway install/,
    );
  });
});
