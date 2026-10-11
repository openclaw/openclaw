import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStateDirDotEnv } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  buildLaunchAgentPlist,
  readLaunchAgentProgramArgumentsFromFile,
} from "../daemon/launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "../daemon/launchd-plist.test-support.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => true),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolvePreferredBunPath: vi.fn(),
  resolvePreferredNodePath: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildServiceEnvironment: vi.fn(),
  resolveOpenClawWrapperPath: vi.fn(),
  assertNoSystemLaunchDaemonOwnership: vi.fn(),
  execLaunchctl: vi.fn(),
  loadPluginManifestRegistryCore: vi.fn<(...args: unknown[]) => PluginManifestRegistry>(() => ({
    diagnostics: [],
    plugins: [],
  })),
  loadPluginManifestRegistryForPluginRegistry: vi.fn<
    (...args: unknown[]) => PluginManifestRegistry
  >(() => ({
    diagnostics: [],
    plugins: [],
  })),
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: vi.fn(
    async (_command: string, args: string[], options: { input: string | Uint8Array }) =>
      decodeLaunchAgentPlistFixture(options.input, args[1]),
  ),
}));

vi.mock("./daemon-install-auth-profiles-source.runtime.js", () => ({
  hasAnyAuthProfileStoreSource: mocks.hasAnyAuthProfileStoreSource,
}));

vi.mock("./daemon-install-auth-profiles-store.runtime.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: mocks.loadAuthProfileStoreForSecretsRuntime,
}));

vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolveNodeRuntimeInfo: async () => ({ status: "unsupported" }),
  resolvePreferredBunPath: mocks.resolvePreferredBunPath,
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

vi.mock("../daemon/program-args.js", () => ({
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveGatewayProgramArguments: mocks.resolveGatewayProgramArguments,
  resolveOpenClawWrapperPath: mocks.resolveOpenClawWrapperPath,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildServiceEnvironment: mocks.buildServiceEnvironment,
}));

vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryCore(...args),
}));

vi.mock("../daemon/launchd-exec.js", async (importActual) => ({
  ...(await importActual<typeof import("../daemon/launchd-exec.js")>()),
  execLaunchctl: mocks.execLaunchctl,
}));

vi.mock("../daemon/launchd-system.js", async (importActual) => ({
  ...(await importActual<typeof import("../daemon/launchd-system.js")>()),
  assertNoSystemLaunchDaemonOwnership: mocks.assertNoSystemLaunchDaemonOwnership,
}));

vi.mock("../plugins/manifest-registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../plugins/manifest-registry.js")>();
  const hasPluginIntegrationProvider = (
    params?: Parameters<typeof actual.loadPluginManifestRegistryCore>[0],
  ) =>
    Object.values(params?.config?.secrets?.providers ?? {}).some(
      (provider) =>
        provider?.source === "exec" &&
        typeof provider === "object" &&
        "pluginIntegration" in provider,
    );
  return {
    ...actual,
    loadPluginManifestRegistryCore: (
      params?: Parameters<typeof actual.loadPluginManifestRegistryCore>[0],
    ) =>
      hasPluginIntegrationProvider(params)
        ? mocks.loadPluginManifestRegistryCore(params)
        : actual.loadPluginManifestRegistryCore(params),
  };
});

vi.mock("../plugins/plugin-registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
  };
});

import { stageLaunchAgent } from "../daemon/launchd.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";

beforeEach(() => {
  mockNodeGatewayPlanFixture();
});

afterEach(() => {
  vi.resetAllMocks();
});

function buildNodePlan(
  params: Omit<Parameters<typeof buildGatewayInstallPlan>[0], "port" | "runtime">,
) {
  return buildGatewayInstallPlan({ port: 3000, runtime: "node", ...params });
}

function firstMockArg(mockFn: ReturnType<typeof vi.fn>, label: string): Record<string, any> {
  const call = mockFn.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} call`);
  }
  const arg = call.at(0);
  if (!arg || typeof arg !== "object") {
    throw new Error(`Expected ${label} first argument`);
  }
  return arg as Record<string, any>;
}

function writeSecurePluginEntrypoint(pathname: string): void {
  fs.writeFileSync(pathname, "");
  fs.chmodSync(pathname, 0o644);
}

function createSecurePluginRoot(pathname: string): void {
  fs.mkdirSync(pathname);
  fs.chmodSync(pathname, 0o755);
}

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
    version = "22.0.0",
    supported = true,
    warning,
    serviceEnvironment = { OPENCLAW_PORT: "3000" },
  } = params;
  const workingDirectory = Object.hasOwn(params, "workingDirectory")
    ? params.workingDirectory
    : "/Users/me";
  mocks.resolvePreferredNodePath.mockResolvedValue("/opt/node");
  mocks.resolveOpenClawWrapperPath.mockImplementation(async (value: string | undefined) =>
    value?.trim() ? path.resolve(value) : undefined,
  );
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
    status: supported ? "supported" : "unsupported",
  });
  mocks.renderSystemNodeWarning.mockReturnValue(warning);
  mocks.buildServiceEnvironment.mockReturnValue(serviceEnvironment);
  mocks.loadPluginManifestRegistryCore.mockReturnValue({ diagnostics: [], plugins: [] });
  mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [],
  });
}

function mockLaunchAgentPlanFixture() {
  mockNodeGatewayPlanFixture({
    serviceEnvironment: {
      HOME: "/from-service",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
      OPENCLAW_PORT: "3000",
    },
  });
}

async function readGeneratedLaunchAgentFixture(params: {
  root: string;
  environment: Record<string, string>;
}) {
  const label = "ai.openclaw.gateway";
  const envDir = path.join(params.root, "service-env");
  const envFilePath = path.join(envDir, `${label}.env`);
  const wrapperPath = path.join(envDir, `${label}-env-wrapper.sh`);
  const plistPath = path.join(params.root, `${label}.plist`);
  fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    envFilePath,
    [
      "# Generated by OpenClaw. Do not edit while the gateway service is installed.",
      ...Object.entries(params.environment).map(
        ([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'`,
      ),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    plistPath,
    buildLaunchAgentPlist({
      label,
      programArguments: [
        "/bin/sh",
        wrapperPath,
        envFilePath,
        "/opt/node",
        "openclaw.mjs",
        "gateway",
        "run",
      ],
      stdoutPath: path.join(params.root, "gateway.log"),
      stderrPath: "/dev/null",
    }),
    { mode: 0o600 },
  );
  const command = await readLaunchAgentProgramArgumentsFromFile(plistPath, {
    expectedEnvironmentWrapperPath: wrapperPath,
    expectedEnvironmentFilePath: envFilePath,
    generatedEnvironmentLabel: label,
  });
  if (!command?.environment) {
    throw new Error("Expected generated LaunchAgent environment fixture");
  }
  return command;
}

async function buildPluginConfigExecSecretRefPlan(home: string) {
  mockNodeGatewayPlanFixture({ serviceEnvironment: { OPENCLAW_PORT: "3000" } });
  const pluginRoot = path.join(home, "acme-secrets");
  createSecurePluginRoot(pluginRoot);
  writeSecurePluginEntrypoint(path.join(pluginRoot, "secret-ref-resolver.js"));
  const configuredPluginRoot = path.join(home, "acme-plugin");
  createSecurePluginRoot(configuredPluginRoot);
  mocks.loadPluginManifestRegistryCore.mockReturnValue({
    diagnostics: [],
    plugins: [
      createPluginManifestRecordFixture({
        id: "acme-secrets",
        origin: "global",
        rootDir: pluginRoot,
        channels: [],
        secretProviderIntegrations: {
          "secret-store": {
            source: "exec",
            command: "${node}",
            args: ["./secret-ref-resolver.js"],
            passEnv: ["ACME_SECRETS_TOKEN"],
          },
        },
      }),
      createPluginManifestRecordFixture({
        id: "acme-plugin",
        origin: "global",
        rootDir: configuredPluginRoot,
        channels: [],
        configContracts: {
          secretInputs: {
            paths: [{ path: "apiKey", expected: "string" }],
          },
        },
      }),
    ],
  });
  mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [
      createPluginManifestRecordFixture({
        id: "acme-plugin",
        origin: "global",
        rootDir: configuredPluginRoot,
        channels: [],
        configContracts: {
          secretInputs: {
            paths: [{ path: "apiKey", expected: "string" }],
          },
        },
      }),
    ],
  });

  return await buildNodePlan({
    env: { HOME: home, ACME_SECRETS_TOKEN: "secret-token" },
    config: {
      plugins: {
        enabled: true,
        entries: {
          "acme-plugin": {
            enabled: true,
            config: {
              apiKey: {
                source: "exec",
                provider: "team-secrets",
                id: "providers/acme-plugin/apiKey",
              },
            },
          },
        },
      },
      secrets: {
        providers: {
          "team-secrets": {
            source: "exec",
            pluginIntegration: {
              pluginId: "acme-secrets",
              integrationId: "secret-store",
            },
          },
        },
      },
    },
  });
}

describe("buildGatewayInstallPlan", () => {
  beforeAll(async () => {
    const { resolveConfigSecretTargetByPath } = await import("../secrets/target-registry.js");
    resolveConfigSecretTargetByPath(["channels", "discord", "token"]);
    const warmHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plan-plugin-warm-"));
    try {
      await buildPluginConfigExecSecretRefPlan(warmHome);
    } finally {
      fs.rmSync(warmHome, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  // Prevent tests from reading the developer's real ~/.openclaw/.env when
  // passing `env: {}` (which falls back to os.homedir for state-dir resolution).
  let isolatedHome: string;
  beforeEach(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plan-test-"));
  });
  afterEach(() => {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  });
  const isolatedPlanEnv = (env: Record<string, string | undefined> = {}) => ({
    HOME: isolatedHome,
    ...env,
  });

  it("resolves and forwards Bun for a Bun Gateway install plan", async () => {
    const bunPath = "/home/test/.bun/bin/bun";
    mocks.resolvePreferredBunPath.mockResolvedValue(bunPath);
    mocks.resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: [bunPath, "/opt/openclaw/dist/index.js", "gateway"],
    });

    await buildGatewayInstallPlan({
      env: { HOME: isolatedHome },
      port: 3000,
      runtime: "bun",
    });

    expect(mocks.resolvePreferredBunPath).toHaveBeenCalledWith({
      env: { HOME: isolatedHome },
      runtime: "bun",
    });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.resolveGatewayProgramArguments).toHaveBeenCalledWith({
      port: 3000,
      allowUnconfigured: false,
      dev: false,
      runtime: "bun",
      runtimePath: bunPath,
      wrapperPath: undefined,
    });
    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(firstMockArg(mocks.buildServiceEnvironment, "buildServiceEnvironment").runtime).toBe(
      "bun",
    );
  });

  it.each([{ mode: "remote" as const, allowUnconfigured: undefined, expectedOverride: true }])(
    "preserves managed launch options through repair: $mode $allowUnconfigured",
    async ({ mode, allowUnconfigured, expectedOverride }) => {
      mockNodeGatewayPlanFixture();
      const managedDefinition = {
        programArguments: [
          "node",
          "--max-heap-size=24576",
          "cli.js",
          "gateway",
          "--allow-unconfigured",
        ],
        environment: { NODE_OPTIONS: "--max-old-space-size=6144" },
      };
      const existingCommand = {
        ...managedDefinition,
        environment: { NODE_OPTIONS: "--max-old-space-size=512 --require=/operator/preload.js" },
        managedDefinition,
        managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
      };

      await buildGatewayInstallPlan({
        env: {
          HOME: isolatedHome,
          NODE_OPTIONS: "--max-old-space-size=16384",
        },
        port: 3000,
        runtime: "node",
        existingCommand,
        config: { gateway: { mode } },
        allowUnconfigured,
      });

      expect(
        firstMockArg(mocks.buildServiceEnvironment, "buildServiceEnvironment").existingNodeOptions,
      ).toBe("--max-old-space-size=6144");
      expect(mocks.resolveGatewayProgramArguments).toHaveBeenCalledWith(
        expect.objectContaining({ existingCommand, allowUnconfigured: expectedOverride }),
      );
    },
  );

  it("adds the active openclaw command bin directory to the managed service PATH", async () => {
    const originalArgv = process.argv;
    const openclawBinPath = path.join(isolatedHome, ".npm-global", "bin", "openclaw");
    process.argv = ["node", openclawBinPath, "gateway", "install"];

    try {
      await buildNodePlan({
        env: { HOME: isolatedHome },
        runtimePath: "/opt/homebrew/opt/node/bin/node",
        platform: "darwin",
      });
    } finally {
      process.argv = originalArgv;
    }

    expect(
      firstMockArg(mocks.buildServiceEnvironment, "buildServiceEnvironment").extraPathDirs,
    ).toStrictEqual(["/opt/homebrew/opt/node/bin", path.dirname(openclawBinPath)]);
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

    await buildNodePlan({
      env: isolatedPlanEnv(),
      warn,
    });

    expect(warn).toHaveBeenCalledWith("Node too old", "Gateway runtime");
  });

  it("uses the state dir as the default macOS launchd working directory", async () => {
    mockNodeGatewayPlanFixture({
      workingDirectory: undefined,
      serviceEnvironment: {},
    });

    const plan = await buildNodePlan({
      env: isolatedPlanEnv(),
      platform: "darwin",
    });

    expect(plan.workingDirectory).toBe(path.join(isolatedHome, ".openclaw"));
    expect(mocks.buildServiceEnvironment).toHaveBeenCalledOnce();
    expect(firstMockArg(mocks.buildServiceEnvironment, "buildServiceEnvironment").platform).toBe(
      "darwin",
    );
  });

  it("passes OPENCLAW_WRAPPER through program args and managed service env", async () => {
    const wrapperPath = path.resolve("/usr/local/bin/openclaw-doppler");
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
        OPENCLAW_WRAPPER: wrapperPath,
      },
    });

    const plan = await buildNodePlan({
      env: isolatedPlanEnv({
        OPENCLAW_WRAPPER: wrapperPath,
      }),
    });

    expect(mocks.resolveGatewayProgramArguments).toHaveBeenCalledOnce();
    expect(
      firstMockArg(mocks.resolveGatewayProgramArguments, "resolveGatewayProgramArguments")
        .wrapperPath,
    ).toBe(wrapperPath);
    expect(mocks.buildServiceEnvironment).toHaveBeenCalledOnce();
    expect(
      firstMockArg(mocks.buildServiceEnvironment, "buildServiceEnvironment").env?.OPENCLAW_WRAPPER,
    ).toBe(wrapperPath);
    expect(plan.environment.OPENCLAW_WRAPPER).toBe(wrapperPath);
  });

  it("clears a Windows wrapper env that points at the generated gateway.cmd script", async () => {
    const selfWrapperPath = path.join(isolatedHome, ".openclaw", "gateway.cmd");
    const warn = vi.fn();

    const plan = await buildNodePlan({
      env: isolatedPlanEnv({
        OPENCLAW_WRAPPER: selfWrapperPath,
      }),
      platform: "win32",
      warn,
    });

    expect(mocks.resolveGatewayProgramArguments).toHaveBeenCalledOnce();
    expect(
      firstMockArg(mocks.resolveGatewayProgramArguments, "resolveGatewayProgramArguments")
        .wrapperPath,
    ).toBeUndefined();
    expect(mocks.resolveGatewayProgramArguments).toHaveBeenCalledWith(
      expect.objectContaining({ runtimePath: "/opt/node" }),
    );
    expect(mocks.buildServiceEnvironment).toHaveBeenCalledOnce();
    expect(
      firstMockArg(mocks.buildServiceEnvironment, "buildServiceEnvironment").env?.OPENCLAW_WRAPPER,
    ).toBeUndefined();
    expect(plan.environment.OPENCLAW_WRAPPER).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Ignoring OPENCLAW_WRAPPER because it points to the Windows task script",
      ),
    );
  });

  it("tracks safe config env keys without embedding literal values", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/Users/service",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildNodePlan({
      env: isolatedPlanEnv(),
      config: {
        env: {
          HOME: "/Users/config",
          CUSTOM_VAR: "custom-value",
          EMPTY_KEY: "",
          TRIMMED_KEY: "  ",
          vars: {
            GOOGLE_API_KEY: "test-key", // pragma: allowlist secret
            OPENCLAW_PORT: "9999",
            NODE_OPTIONS: "--require /tmp/evil.js",
            SAFE_KEY: "safe-value",
          },
        },
      },
    });

    expect(plan.environment.GOOGLE_API_KEY).toBeUndefined();
    expect(plan.environment.CUSTOM_VAR).toBeUndefined();
    expect(plan.environment.SAFE_KEY).toBeUndefined();
    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.EMPTY_KEY).toBeUndefined();
    expect(plan.environment.TRIMMED_KEY).toBeUndefined();
    expect(plan.environment.HOME).toBe("/Users/service");
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe(
      "CUSTOM_VAR,GOOGLE_API_KEY,SAFE_KEY",
    );
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
  });

  it("keeps first-install provider API keys file-backed without capturing unrelated credentials", async () => {
    mocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);

    const plan = await buildNodePlan({
      env: isolatedPlanEnv({
        OPENAI_API_KEY: "ambient-openai",
        ANTHROPIC_API_KEY: "ambient-anthropic",
        ANTHROPIC_OAUTH_TOKEN: "ambient-oauth",
        ANTHROPIC_ADMIN_API_KEY: "ambient-anthropic-admin",
        OPENAI_ADMIN_KEY: "ambient-openai-admin",
        GITHUB_TOKEN: "ambient-github",
        GH_TOKEN: "ambient-gh",
        UNRECOGNIZED_API_KEY: "ambient-unrecognized",
        NODE_OPTIONS: "--require /tmp/untrusted.js",
      }),
      platform: "linux",
      config: {},
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("ambient-openai");
    expect(plan.environment.ANTHROPIC_API_KEY).toBe("ambient-anthropic");
    expect(plan.environmentValueSources?.OPENAI_API_KEY).toBe("file");
    expect(plan.environmentValueSources?.ANTHROPIC_API_KEY).toBe("file");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
    expect(plan.environment.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(plan.environment.ANTHROPIC_ADMIN_API_KEY).toBeUndefined();
    expect(plan.environment.OPENAI_ADMIN_KEY).toBeUndefined();
    expect(plan.environment.GITHUB_TOKEN).toBeUndefined();
    expect(plan.environment.GH_TOKEN).toBeUndefined();
    expect(plan.environment.UNRECOGNIZED_API_KEY).toBeUndefined();
    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
  });

  it("does not let enabled third-party plugins capture ambient provider API keys", async () => {
    const pluginId = "third-party-provider";
    const pluginRoot = path.join(isolatedHome, pluginId);
    createSecurePluginRoot(pluginRoot);
    writeSecurePluginEntrypoint(path.join(pluginRoot, "index.js"));
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false },
        setup: { providers: [{ id: pluginId, envVars: ["THIRD_PARTY_API_KEY"] }] },
        providerAuthChoices: [
          {
            provider: pluginId,
            method: "api-key",
            choiceId: "third-party-api-key",
            appGuidedSecret: true,
          },
        ],
      }),
    );
    mocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);
    const env = isolatedPlanEnv({
      OPENAI_API_KEY: "bundled-openai",
      THIRD_PARTY_API_KEY: "ambient-third-party",
    });
    const config: OpenClawConfig = {
      plugins: {
        enabled: true,
        load: { paths: [pluginRoot] },
        entries: { [pluginId]: { enabled: true } },
      },
    };
    const { loadManifestMetadataSnapshot } =
      await import("../plugins/manifest-contract-eligibility.js");
    const snapshot = loadManifestMetadataSnapshot({ config, env });
    const externalPlugin = snapshot.plugins.find(({ id }) => id === pluginId);
    expect(externalPlugin).toEqual(expect.objectContaining({ origin: "config" }));
    expect(externalPlugin?.trustedOfficialInstall).not.toBe(true);
    expect(snapshot.index.plugins.find(({ pluginId: id }) => id === pluginId)?.enabled).toBe(true);

    const plan = await buildNodePlan({
      env,
      config,
      platform: "linux",
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("bundled-openai");
    expect(plan.environment.THIRD_PARTY_API_KEY).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
  });

  it.each([
    { currentOpenAiKey: "rotated-operator-openai", expectedOpenAiKey: "rotated-operator-openai" },
  ])(
    "retires managed provider keys while preserving genuinely rotated replacements",
    async ({ currentOpenAiKey, expectedOpenAiKey }) => {
      mocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);

      const plan = await buildNodePlan({
        env: isolatedPlanEnv({
          OPENAI_API_KEY: currentOpenAiKey,
          ANTHROPIC_API_KEY: "fresh-operator-anthropic",
        }),
        existingEnvironment: {
          OPENAI_API_KEY: "existing-managed-openai",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENAI_API_KEY",
        },
        existingEnvironmentValueSources: { OPENAI_API_KEY: "file" },
        platform: "linux",
        config: {},
      });

      expect(plan.environment.OPENAI_API_KEY).toBe(expectedOpenAiKey);
      expect(plan.environmentValueSources?.OPENAI_API_KEY).toBe(
        expectedOpenAiKey ? "file" : undefined,
      );
      expect(plan.environment.ANTHROPIC_API_KEY).toBe("fresh-operator-anthropic");
      expect(plan.environmentValueSources?.ANTHROPIC_API_KEY).toBe("file");
      expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
    },
  );

  it("keeps config env SecretRefs managed when auth profiles reuse the key", async () => {
    const plan = await buildNodePlan({
      env: isolatedPlanEnv({
        OPENAI_API_KEY: "sk-openai-test",
      }),
      platform: "linux",
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      },
      authStore: {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      },
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(plan.environmentValueSources?.OPENAI_API_KEY).toBe("file");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("OPENAI_API_KEY");
  });

  it("includes passEnv values for plugin config exec SecretRefs", async () => {
    const plan = await buildPluginConfigExecSecretRefPlan(isolatedHome);

    expect(plan.environment.ACME_SECRETS_TOKEN).toBe("secret-token");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
  });

  it("includes passEnv values for auth-profile plugin-managed exec SecretRef providers", async () => {
    const pluginRoot = path.join(isolatedHome, "acme-secrets");
    createSecurePluginRoot(pluginRoot);
    writeSecurePluginEntrypoint(path.join(pluginRoot, "secret-ref-resolver.js"));
    mocks.loadPluginManifestRegistryCore.mockReturnValue({
      diagnostics: [],
      plugins: [
        createPluginManifestRecordFixture({
          id: "acme-secrets",
          origin: "global",
          rootDir: pluginRoot,
          secretProviderIntegrations: {
            "secret-store": {
              source: "exec",
              command: "${node}",
              args: ["./secret-ref-resolver.js"],
              passEnv: ["ACME_SECRETS_ADDR", "ACME_SECRETS_TOKEN"],
            },
          },
        }),
      ],
    });

    const plan = await buildNodePlan({
      env: isolatedPlanEnv({
        ACME_SECRETS_ADDR: "http://secrets.example.test",
        ACME_SECRETS_TOKEN: "secret-token",
      }),
      config: {
        secrets: {
          providers: {
            "team-secrets": {
              source: "exec",
              pluginIntegration: {
                pluginId: "acme-secrets",
                integrationId: "secret-store",
              },
            },
          },
        },
      },
      authStore: {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: {
              source: "exec",
              provider: "team-secrets",
              id: "providers/openai/apiKey",
            },
          },
        },
      },
    });

    expect(plan.environment.ACME_SECRETS_ADDR).toBe("http://secrets.example.test");
    expect(plan.environment.ACME_SECRETS_TOKEN).toBe("secret-token");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
  });

  it.each(["linux"] as const)(
    "ignores missing passEnv values while blocking populated dangerous values on %s",
    async (platform) => {
      const env = isolatedPlanEnv({
        SYSTEMROOT: " ",
        SAFE_PASS_ENV: " safe-value ",
        BASH_ENV: "/tmp/openclaw-test-bashenv",
        XDG_CONFIG_HOME: "/tmp/openclaw-test-xdg-home",
        XDG_CONFIG_DIRS: "/etc/xdg:/opt/xdg",
        GH_TOKEN: "gh-test-token",
        AWS_ACCESS_KEY_ID: "aws-access-key",
        DOCKER_HOST: "tcp://docker.example.test:2376",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      });
      Object.setPrototypeOf(env, { WINDIR: "C:/Inherited" });
      const warn = vi.fn();
      const plan = await buildNodePlan({
        env,
        platform,
        warn,
        config: {
          secrets: {
            providers: {
              onepassword: {
                source: "exec",
                command: "/usr/bin/op",
                args: ["read", "op://Private/Discord/password"],
                passEnv: [
                  "HOME",
                  "NODE_OPTIONS",
                  "SYSTEMROOT",
                  "WINDIR",
                  "SAFE_PASS_ENV",
                  "BASH_ENV",
                  "XDG_CONFIG_HOME",
                  "XDG_CONFIG_DIRS",
                  "GH_TOKEN",
                  "AWS_ACCESS_KEY_ID",
                  "DOCKER_HOST",
                  "NODE_TLS_REJECT_UNAUTHORIZED",
                ],
              },
            },
          },
          channels: {
            discord: {
              token: { source: "exec", provider: "onepassword", id: "value" },
            },
          },
        },
      });

      expect(plan.environment.HOME).toBe(isolatedHome);
      expect(plan.environment.SAFE_PASS_ENV).toBe("safe-value");
      for (const blockedName of [
        "NODE_OPTIONS",
        "SYSTEMROOT",
        "WINDIR",
        "BASH_ENV",
        "XDG_CONFIG_HOME",
        "XDG_CONFIG_DIRS",
        "GH_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "DOCKER_HOST",
        "NODE_TLS_REJECT_UNAUTHORIZED",
      ]) {
        expect(plan.environment[blockedName]).toBeUndefined();
      }
      const warningOutput = warn.mock.calls.map(([message]) => message).join("\n");
      for (const silentName of ["HOME", "NODE_OPTIONS", "SYSTEMROOT", "WINDIR"]) {
        expect(warn).not.toHaveBeenCalledWith(
          `Exec SecretRef passEnv ref "${silentName}" blocked by host-env security policy`,
          "Config SecretRef",
        );
      }
      for (const blockedName of [
        "XDG_CONFIG_HOME",
        "XDG_CONFIG_DIRS",
        "BASH_ENV",
        "GH_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "DOCKER_HOST",
        "NODE_TLS_REJECT_UNAUTHORIZED",
      ]) {
        expect(warningOutput).toContain(blockedName);
      }
      expect(warn.mock.calls.every(([, title]) => title === "Config SecretRef")).toBe(true);
    },
  );

  it("does not include passEnv values for unused exec SecretRef providers", async () => {
    const plan = await buildNodePlan({
      env: isolatedPlanEnv({
        OP_CONNECT_TOKEN: "op-connect-token",
      }),
      config: {
        secrets: {
          providers: {
            onepassword: {
              source: "exec",
              command: "/usr/bin/op",
              passEnv: ["OP_CONNECT_TOKEN"],
            },
          },
        },
      },
    });

    expect(plan.environment.OP_CONNECT_TOKEN).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
  });

  it("does not embed gateway auth SecretRef values into the service environment", async () => {
    const plan = await buildNodePlan({
      env: isolatedPlanEnv({
        OPENCLAW_GATEWAY_TOKEN: "gateway-test-token",
      }),
      config: {
        gateway: {
          auth: {
            token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
          },
        },
      },
    });

    expect(plan.environment.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("OPENCLAW_GATEWAY_TOKEN");
  });

  it("does not inline config env SecretRef values already backed by state-dir dotenv", async () => {
    await writeStateDirDotEnv("DISCORD_BOT_TOKEN=discord-dotenv-token\n", {
      stateDir: path.join(isolatedHome, ".openclaw"),
    });

    const plan = await buildNodePlan({
      env: isolatedPlanEnv({
        DISCORD_BOT_TOKEN: "discord-shell-token",
      }),
      config: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          },
        },
      },
    });

    expect(plan.environment.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("DISCORD_BOT_TOKEN");
  });

  it("merges only portable auth-profile env refs into the service environment", async () => {
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
        "broken:default": {
          type: "token",
          provider: "broken",
          tokenRef: { source: "env", provider: "default", id: "BAD KEY" },
        },
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
        "missing:default": {
          type: "token",
          provider: "missing",
          tokenRef: { source: "env", provider: "default", id: "MISSING_TOKEN" },
        },
      },
    });

    const warn = vi.fn();
    const plan = await buildNodePlan({
      env: isolatedPlanEnv({
        NODE_OPTIONS: "--require ./pwn.js",
        GIT_ASKPASS: "/tmp/askpass.sh",
        OPENAI_API_KEY: "sk-openai-test", // pragma: allowlist secret
        ANTHROPIC_TOKEN: "ant-test-token",
      }),
      warn,
    });

    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.GIT_ASKPASS).toBeUndefined();
    expect(plan.environment["BAD KEY"]).toBeUndefined();
    expect(plan.environment.MISSING_TOKEN).toBeUndefined();
    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(plan.environment.ANTHROPIC_TOKEN).toBe("ant-test-token");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Auth profile env ref "NODE_OPTIONS" blocked by host-env security policy',
      "Auth profile",
    );
    expect(warn).toHaveBeenCalledWith(
      'Auth profile env ref "GIT_ASKPASS" blocked by host-env security policy',
      "Auth profile",
    );
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

  it("retains active gateway auth and channel SecretRefs through real LaunchAgent regeneration", async () => {
    mockLaunchAgentPlanFixture();
    const existing = await readGeneratedLaunchAgentFixture({
      root: tmpDir,
      environment: {
        OPENCLAW_GATEWAY_AUTH_TOKEN: "gateway-existing-env-file-token",
        OLD_GATEWAY_AUTH_TOKEN: "stale-gateway-token",
        RETIRED_BOTTOKEN: "retired-channel-token",
        TELEGRAM_DEFAULT_BOTTOKEN: "telegram-existing-env-file-token",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS:
          "OLD_GATEWAY_AUTH_TOKEN,OPENCLAW_GATEWAY_AUTH_TOKEN,RETIRED_BOTTOKEN,TELEGRAM_DEFAULT_BOTTOKEN",
      },
    });

    const plan = await buildNodePlan({
      env: { HOME: tmpDir },
      platform: "darwin",
      existingEnvironment: existing.environment,
      existingEnvironmentValueSources: existing.environmentValueSources,
      config: {
        gateway: {
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_AUTH_TOKEN",
            },
          },
        },
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: {
                  source: "env",
                  provider: "default",
                  id: "TELEGRAM_DEFAULT_BOTTOKEN",
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(plan.environment.OPENCLAW_GATEWAY_AUTH_TOKEN).toBe("gateway-existing-env-file-token");
    expect(plan.environment.TELEGRAM_DEFAULT_BOTTOKEN).toBe("telegram-existing-env-file-token");
    expect(plan.environmentValueSources?.OPENCLAW_GATEWAY_AUTH_TOKEN).toBe("file");
    expect(plan.environmentValueSources?.TELEGRAM_DEFAULT_BOTTOKEN).toBe("file");
    expect(plan.environment.OLD_GATEWAY_AUTH_TOKEN).toBeUndefined();
    expect(plan.environment.RETIRED_BOTTOKEN).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe(
      "OPENCLAW_GATEWAY_AUTH_TOKEN,TELEGRAM_DEFAULT_BOTTOKEN",
    );

    const home = path.join(tmpDir, "rewritten-home");
    const stateDir = path.join(home, ".openclaw");
    const label = "ai.openclaw.gateway";
    mocks.assertNoSystemLaunchDaemonOwnership.mockResolvedValue(undefined);
    mocks.execLaunchctl.mockResolvedValue({ code: 1, stdout: "", stderr: "not loaded" });
    await stageLaunchAgent({
      env: { HOME: home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_LAUNCHD_LABEL: label },
      stdout: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      programArguments: plan.programArguments,
      workingDirectory: plan.workingDirectory,
      environment: plan.environment,
      environmentValueSources: plan.environmentValueSources,
    });

    const envFilePath = path.join(stateDir, "service-env", `${label}.env`);
    const wrapperPath = path.join(stateDir, "service-env", `${label}-env-wrapper.sh`);
    const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
    const [envFile, plist, envStat, wrapperStat, plistStat] = await Promise.all([
      fs.promises.readFile(envFilePath, "utf8"),
      fs.promises.readFile(plistPath, "utf8"),
      fs.promises.stat(envFilePath),
      fs.promises.stat(wrapperPath),
      fs.promises.stat(plistPath),
    ]);
    expect(envStat.mode & 0o777).toBe(0o600);
    expect(wrapperStat.mode & 0o777).toBe(0o700);
    expect(plistStat.mode & 0o777).toBe(0o644);
    expect(envFile).toContain(
      "export OPENCLAW_GATEWAY_AUTH_TOKEN='gateway-existing-env-file-token'",
    );
    expect(envFile).toContain(
      "export TELEGRAM_DEFAULT_BOTTOKEN='telegram-existing-env-file-token'",
    );
    expect(envFile).not.toContain("OLD_GATEWAY_AUTH_TOKEN");
    expect(envFile).not.toContain("RETIRED_BOTTOKEN");
    expect(plist).not.toContain("OPENCLAW_GATEWAY_AUTH_TOKEN");
    expect(plist).not.toContain("TELEGRAM_DEFAULT_BOTTOKEN");
    expect(plist).not.toContain("gateway-existing-env-file-token");
    expect(plist).not.toContain("telegram-existing-env-file-token");

    const rewritten = await readLaunchAgentProgramArgumentsFromFile(plistPath, {
      expectedEnvironmentWrapperPath: wrapperPath,
      expectedEnvironmentFilePath: envFilePath,
      generatedEnvironmentLabel: label,
    });
    expect(rewritten?.environment?.OPENCLAW_GATEWAY_AUTH_TOKEN).toBe(
      "gateway-existing-env-file-token",
    );
    expect(rewritten?.environment?.TELEGRAM_DEFAULT_BOTTOKEN).toBe(
      "telegram-existing-env-file-token",
    );
    expect(rewritten?.environmentValueSources?.OPENCLAW_GATEWAY_AUTH_TOKEN).toBe("file");
  });

  const gatewayAuthPersistenceCases = [
    {
      platform: "darwin",
      testCase: {
        name: "token inline-only match",
        surface: "token",
        mode: "token",
        configuredKey: "OPENCLAW_GATEWAY_TOKEN",
        existingKey: "OPENCLAW_GATEWAY_TOKEN",
        existingSource: "inline",
        expectedValue: "existing-secret",
        processValue: "process-secret",
      },
    },
    {
      platform: "win32",
      testCase: {
        name: "token file-backed match",
        surface: "token",
        mode: "token",
        configuredKey: "OPENCLAW_GATEWAY_AUTH_TOKEN",
        existingKey: "OPENCLAW_GATEWAY_AUTH_TOKEN",
        existingSource: "file",
        expectedValue: "existing-secret",
      },
    },
    {
      platform: "linux",
      testCase: {
        name: "inactive token ref",
        surface: "token",
        mode: "password",
        configuredKey: "OPENCLAW_GATEWAY_AUTH_TOKEN",
        existingKey: "OPENCLAW_GATEWAY_AUTH_TOKEN",
        existingSource: "file",
      },
    },
  ] as const;
  it.each(gatewayAuthPersistenceCases)(
    "preserves $platform gateway auth: $testCase.name",
    async ({ platform, testCase }) => {
      mockNodeGatewayPlanFixture({
        serviceEnvironment: {
          HOME: "/from-service",
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
          OPENCLAW_PORT: "3000",
        },
      });
      const configuredKey = "configuredKey" in testCase ? testCase.configuredKey : undefined;
      const existingKey = "existingKey" in testCase ? testCase.existingKey : undefined;
      const existingSource = "existingSource" in testCase ? testCase.existingSource : undefined;
      const processValue = "processValue" in testCase ? testCase.processValue : undefined;
      const auth: Record<string, unknown> = { mode: testCase.mode };
      if (configuredKey) {
        auth[testCase.surface] = {
          source: "env",
          provider: "default",
          id: configuredKey,
        };
      }
      if (testCase.surface !== testCase.mode) {
        auth[testCase.mode] = "configured-active-secret";
      }
      const existingEnvironment = existingKey
        ? {
            [existingKey]: "existing-secret",
            ...(existingSource === "inline"
              ? {}
              : { OPENCLAW_SERVICE_MANAGED_ENV_KEYS: existingKey }),
          }
        : undefined;
      const existingEnvironmentValueSources =
        existingKey && existingSource ? { [existingKey]: existingSource } : undefined;
      const processEnvironment =
        configuredKey && processValue ? { [configuredKey]: processValue } : {};

      const plan = await buildNodePlan({
        env: { HOME: tmpDir, ...processEnvironment },
        platform,
        existingEnvironment,
        existingEnvironmentValueSources,
        config: { gateway: { auth } } as unknown as OpenClawConfig,
      });

      if (existingKey) {
        const expectedValue =
          platform !== "win32" && "expectedValue" in testCase ? testCase.expectedValue : undefined;
        expect(plan.environment[existingKey]).toBe(expectedValue);
        expect(plan.environmentValueSources?.[existingKey]).toBe(
          expectedValue ? "file" : undefined,
        );
      }
      if (configuredKey && configuredKey !== existingKey) {
        expect(plan.environment[configuredKey]).toBeUndefined();
      }
      expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe(
        configuredKey && testCase.surface === testCase.mode ? configuredKey : undefined,
      );
    },
  );

  it("drops legacy inline env values when the key is now managed by .env", async () => {
    await writeStateDirDotEnv("TAVILY_API_KEY=fresh-dotenv-value\n", {
      stateDir: path.join(tmpDir, ".openclaw"),
    });
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildNodePlan({
      env: { HOME: tmpDir },
      existingEnvironment: {
        TAVILY_API_KEY: "old-inline-value",
        CUSTOM_TOOL_HOME: "/Users/test/.custom-tool",
      },
    });

    expect(plan.environment.TAVILY_API_KEY).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("TAVILY_API_KEY");
    expect(plan.environment.CUSTOM_TOOL_HOME).toBe("/Users/test/.custom-tool");
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
