import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  CommandInvocation,
  CommandOptions,
  CommandResult,
  ProviderConfig,
} from "../../scripts/lib/cross-os-release-checks/config.ts";
import { runInstalledModelsSet } from "../../scripts/lib/cross-os-release-checks/installed.ts";
import { runModelsSet } from "../../scripts/lib/cross-os-release-checks/runtime.ts";
import { makeReleaseLane } from "./release-lane.test-support.ts";

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

const createProvider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  extensionId: "anthropic",
  secretEnv: "TEST_API_KEY",
  authChoice: "test-key",
  model: "test/model",
  requiredCompanionPackages: [],
  ...overrides,
});

const root = join("fixture", "release");
const env = { RELEASE_TEST: "1" };
const logPath = join(root, "config.log");
const success = { exitCode: 0, stdout: "", stderr: "" };
const baseUrl = "https://example.com/v1";

beforeEach(() => {
  command.mockReset().mockResolvedValue(success);
});

function run(providerConfig: ProviderConfig, adapter: "packaged" | "installed" = "packaged") {
  const params = { env, logPath, providerConfig };
  return adapter === "installed"
    ? runInstalledModelsSet({ ...params, cliPath: join(root, "openclaw"), cwd: root })
    : runModelsSet({
        ...params,
        lane: makeReleaseLane(root, { prefixDir: join(root, "prefix") }),
      });
}

const calledArgs = (adapter: "packaged" | "installed" = "packaged") =>
  command.mock.calls.map(([invocation]) => invocation.args.slice(adapter === "packaged" ? 1 : 0));
function configSet(key: string, value: unknown, ...flags: string[]) {
  return ["config", "set", key, JSON.stringify(value), "--strict-json", ...flags];
}

it.each([
  ["packaged", "anthropic", {}, null],
  [
    "installed",
    "openai",
    { baseUrl, timeoutSeconds: 600 },
    { baseUrl, agentRuntime: { id: "openclaw" }, models: [], timeoutSeconds: 600 },
  ],
  ["packaged", "minimax", { baseUrl }, { baseUrl, models: [] }],
  ["packaged", "browser", { timeoutSeconds: 700 }, { models: [], timeoutSeconds: 700 }],
] as const)(
  "keeps the exact ordered commands through %s for %s",
  async (adapter, extensionId, overrides, expectedOverride) => {
    await run(createProvider({ extensionId, ...overrides }), adapter);
    expect(calledArgs(adapter)).toEqual([
      ["models", "set", "test/model"],
      ...(expectedOverride
        ? [configSet(`models.providers.${extensionId}`, expectedOverride, "--merge")]
        : []),
      configSet(
        "plugins.allow",
        extensionId === "browser"
          ? ["browser", "acpx", "bonjour", "device-pair", "talk-voice"]
          : [extensionId, "acpx", "bonjour", "browser", "device-pair", "talk-voice"],
      ),
      configSet("plugins.slots.memory", "none"),
      configSet("agents.defaults.skipBootstrap", true),
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
  const readBaseUrl = vi.fn(() => {
    throw new Error("later config must remain unread");
  });
  const providerConfig = createProvider();
  Object.defineProperty(providerConfig, "baseUrl", { get: readBaseUrl });
  command.mockRejectedValueOnce(error);

  await expect(run(providerConfig)).rejects.toBe(error);
  expect(calledArgs()).toEqual([["models", "set", "test/model"]]);
  expect(readBaseUrl).not.toHaveBeenCalled();
});
