import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandInvocation,
  CommandOptions,
  CommandResult,
  ProviderConfig,
} from "../../scripts/lib/cross-os-release-checks/config.ts";
import { runInstalledModelsSet } from "../../scripts/lib/cross-os-release-checks/installed.ts";
import { runModelsSet } from "../../scripts/lib/cross-os-release-checks/runtime.ts";

const command = vi.hoisted(() =>
  vi.fn<(invocation: CommandInvocation, options: CommandOptions) => Promise<CommandResult>>(),
);

vi.mock("../../scripts/lib/cross-os-release-checks/process.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/process.ts")
  >()),
  runCommand: (executable: string, args: string[], options: CommandOptions) =>
    command({ command: executable, args, shell: false }, options),
  runCommandInvocation: command,
}));

function createProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    extensionId: "anthropic",
    secretEnv: "TEST_API_KEY",
    authChoice: "test-key",
    model: "test/model",
    requiredCompanionPackages: [],
    ...overrides,
  };
}

describe.each(["packaged", "installed"] as const)("%s release model config", (adapter) => {
  const root = join("fixture", "release");
  const env = { RELEASE_TEST: "1" };
  const logPath = join(root, "config.log");
  const success = { exitCode: 0, stdout: "", stderr: "" };

  beforeEach(() => {
    command.mockReset().mockResolvedValue(success);
  });

  function run(providerConfig: ProviderConfig) {
    const params = { env, logPath, providerConfig };
    return adapter === "installed"
      ? runInstalledModelsSet({ ...params, cliPath: join(root, "openclaw"), cwd: root })
      : runModelsSet({
          ...params,
          lane: {
            name: "probe",
            rootDir: root,
            prefixDir: join(root, "prefix"),
            homeDir: root,
            stateDir: join(root, "state"),
            appDataDir: join(root, "app-data"),
            gatewayPort: 18_789,
            phaseTimings: [],
          },
        });
  }

  function calledArgs() {
    return command.mock.calls.map(([invocation]) =>
      invocation.args.slice(adapter === "packaged" ? 1 : 0),
    );
  }

  it.each([
    { extensionId: "anthropic", overrides: {}, expectedOverride: null },
    {
      extensionId: "openai",
      overrides: { baseUrl: "https://example.com/v1", timeoutSeconds: 600 },
      expectedOverride: {
        baseUrl: "https://example.com/v1",
        agentRuntime: { id: "openclaw" },
        models: [],
        timeoutSeconds: 600,
      },
    },
    {
      extensionId: "minimax",
      overrides: { baseUrl: "https://example.com/v1" },
      expectedOverride: { baseUrl: "https://example.com/v1", models: [] },
    },
    {
      extensionId: "browser",
      overrides: { timeoutSeconds: 700 },
      expectedOverride: { models: [], timeoutSeconds: 700 },
    },
  ])(
    "keeps the exact ordered $extensionId commands",
    async ({ extensionId, overrides, expectedOverride }) => {
      await run(createProvider({ extensionId, ...overrides }));
      expect(calledArgs()).toEqual([
        ["models", "set", "test/model"],
        ...(expectedOverride
          ? [
              [
                "config",
                "set",
                `models.providers.${extensionId}`,
                JSON.stringify(expectedOverride),
                "--strict-json",
                "--merge",
              ],
            ]
          : []),
        [
          "config",
          "set",
          "plugins.allow",
          JSON.stringify(
            extensionId === "browser"
              ? ["browser", "acpx", "bonjour", "device-pair", "talk-voice"]
              : [extensionId, "acpx", "bonjour", "browser", "device-pair", "talk-voice"],
          ),
          "--strict-json",
        ],
        ["config", "set", "plugins.slots.memory", '"none"', "--strict-json"],
        ["config", "set", "agents.defaults.skipBootstrap", "true", "--strict-json"],
        ["config", "set", "tools.profile", "minimal"],
      ]);
      for (const [invocation, options] of command.mock.calls) {
        expect(invocation.command).toBe(
          adapter === "packaged" ? process.execPath : join(root, "openclaw"),
        );
        expect(options).toEqual({ cwd: root, env, logPath, timeoutMs: 120_000, check: true });
        expect(options.env).toBe(env);
      }
    },
  );

  it("does not inspect later config after models set fails", async () => {
    const error = new Error("models set failed");
    const baseUrl = vi.fn(() => {
      throw new Error("later config must remain unread");
    });
    const providerConfig = createProvider();
    Object.defineProperty(providerConfig, "baseUrl", { get: baseUrl });
    command.mockRejectedValueOnce(error);

    await expect(run(providerConfig)).rejects.toBe(error);
    expect(calledArgs()).toEqual([["models", "set", "test/model"]]);
    expect(baseUrl).not.toHaveBeenCalled();
  });

  it("builds later commands after each preceding command completes", async () => {
    const providerConfig = createProvider({ extensionId: "openai" });
    command.mockImplementation(async () => {
      if (command.mock.calls.length === 1) {
        providerConfig.baseUrl = "https://example.com/updated";
        providerConfig.timeoutSeconds = 900;
      } else if (command.mock.calls.length === 2) {
        providerConfig.extensionId = "browser";
      }
      return success;
    });

    await run(providerConfig);
    expect(calledArgs().slice(0, 3)).toEqual([
      ["models", "set", "test/model"],
      [
        "config",
        "set",
        "models.providers.openai",
        JSON.stringify({
          baseUrl: "https://example.com/updated",
          agentRuntime: { id: "openclaw" },
          models: [],
          timeoutSeconds: 900,
        }),
        "--strict-json",
        "--merge",
      ],
      [
        "config",
        "set",
        "plugins.allow",
        JSON.stringify(["browser", "acpx", "bonjour", "device-pair", "talk-voice"]),
        "--strict-json",
      ],
    ]);
  });
});
