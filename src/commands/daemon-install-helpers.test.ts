import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStateDirDotEnv } from "../config/test-helpers.js";

const mocks = vi.hoisted(() => ({
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolvePreferredNodePath: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildServiceEnvironment: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: mocks.loadAuthProfileStoreForSecretsRuntime,
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
  mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
    version: 1,
    profiles: {},
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
  // Prevent tests from reading the developer's real ~/.openclaw/.env when
  // passing `env: {}` (which falls back to os.homedir for state-dir resolution).
  let isolatedHome: string;
  beforeEach(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plan-test-"));
  });
  afterEach(() => {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  });

  it("uses provided nodePath and returns plan", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      port: 3000,
      runtime: "node",
      nodePath: "/custom/node",
    });

    expect(plan.programArguments).toEqual(["node", "gateway"]);
    expect(plan.workingDirectory).toBe("/Users/me");
    expect(plan.environment).toEqual({ OPENCLAW_PORT: "3000" });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { HOME: isolatedHome },
        port: 3000,
        extraPathDirs: ["/custom"],
      }),
    );
  });

  it("does not prepend '.' when nodePath is a bare executable name", async () => {
    mockNodeGatewayPlanFixture();

    await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      port: 3000,
      runtime: "node",
      nodePath: "node",
    });

    expect(mocks.buildServiceEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        extraPathDirs: undefined,
      }),
    );
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
            GOOGLE_API_KEY: "test-key", // pragma: allowlist secret
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

  it("merges env-backed auth-profile refs into the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        OPENAI_API_KEY: "sk-openai-test", // pragma: allowlist secret
        ANTHROPIC_TOKEN: "ant-test-token",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(plan.environment.ANTHROPIC_TOKEN).toBe("ant-test-token");
  });

  it("blocks dangerous auth-profile env refs from the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "node:default": {
          type: "token",
          provider: "node",
          tokenRef: { source: "env", provider: "default", id: "NODE_OPTIONS" },
        },
        "git:default": {
          type: "token",
          provider: "git",
          tokenRef: { source: "env", provider: "default", id: "GIT_ASKPASS" },
        },
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });

    const warn = vi.fn();
    const plan = await buildGatewayInstallPlan({
      env: {
        NODE_OPTIONS: "--require ./pwn.js",
        GIT_ASKPASS: "/tmp/askpass.sh",
        OPENAI_API_KEY: "sk-openai-test", // pragma: allowlist secret
      },
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.GIT_ASKPASS).toBeUndefined();
    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NODE_OPTIONS"), "Auth profile");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("GIT_ASKPASS"), "Auth profile");
  });

  it("skips non-portable auth-profile env ref keys", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "broken:default": {
          type: "token",
          provider: "broken",
          tokenRef: { source: "env", provider: "default", id: "BAD KEY" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        "BAD KEY": "should-not-pass",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment["BAD KEY"]).toBeUndefined();
  });

  it("skips unresolved auth-profile env refs", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("buildGatewayInstallPlan — dotenv merge", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plan-dotenv-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges .env file vars into the install plan", async () => {
    await writeStateDirDotEnv("BRAVE_API_KEY=BSA-from-env\nOPENROUTER_API_KEY=or-key\n", {
      stateDir: path.join(tmpDir, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({ serviceEnvironment: { OPENCLAW_PORT: "3000" } });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.BRAVE_API_KEY).toBe("BSA-from-env");
    expect(plan.environment.OPENROUTER_API_KEY).toBe("or-key");
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
  });

  it("config env vars override .env file vars", async () => {
    await writeStateDirDotEnv("MY_KEY=from-dotenv\n", {
      stateDir: path.join(tmpDir, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({ serviceEnvironment: {} });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            MY_KEY: "from-config",
          },
        },
      },
    });

    expect(plan.environment.MY_KEY).toBe("from-config");
  });

  it("service env overrides .env file vars", async () => {
    await writeStateDirDotEnv("HOME=/from-dotenv\n", {
      stateDir: path.join(tmpDir, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({
      serviceEnvironment: { HOME: "/from-service" },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.HOME).toBe("/from-service");
  });

  it("works when .env file does not exist", async () => {
    mockNodeGatewayPlanFixture({ serviceEnvironment: { OPENCLAW_PORT: "3000" } });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
  });
});

describe("gatewayInstallErrorHint", () => {
  it("returns platform-specific hints", () => {
    expect(gatewayInstallErrorHint("win32")).toContain("Startup-folder login item");
    expect(gatewayInstallErrorHint("win32")).toContain("elevated PowerShell");
    expect(gatewayInstallErrorHint("linux")).toMatch(
      /(?:openclaw|openclaw)( --profile isolated)? gateway install/,
    );
  });
});
