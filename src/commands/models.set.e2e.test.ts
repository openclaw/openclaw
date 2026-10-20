import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelsCli } from "../cli/models-cli.js";
import type {
  ConfigFileSnapshot,
  OpenClawConfig,
  TransformConfigFileParams,
} from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const mocks = vi.hoisted(() => ({
  currentConfig: {} as Record<string, unknown>,
  writtenConfig: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const readConfigFileSnapshot = async (): Promise<ConfigFileSnapshot> => {
    const config = structuredClone(mocks.currentConfig);
    return {
      path: "/tmp/openclaw-models-set-fixture.json",
      exists: true,
      raw: JSON.stringify(config),
      parsed: config,
      valid: true,
      hash: "config-hash",
      sourceConfig: config,
      resolved: config,
      runtimeConfig: structuredClone(config),
      config: structuredClone(config),
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
  };
  return {
    ...actual,
    readConfigFileSnapshot,
    transformConfigFile: async ({ base, transform }: TransformConfigFileParams<unknown>) => {
      const snapshot = await readConfigFileSnapshot();
      const { nextConfig, result } = await transform(
        base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig,
        { snapshot, previousHash: snapshot.hash ?? null, attempt: 0 },
        {},
      );
      mocks.writtenConfig = nextConfig;
      return { nextConfig, result };
    },
  };
});

import { modelsSetCommand } from "./models/set.js";

function mockConfigSnapshot(config: Record<string, unknown> = {}) {
  mocks.currentConfig = config;
  mocks.writtenConfig = undefined;
}

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

function getWrittenConfig(): OpenClawConfig {
  if (!mocks.writtenConfig) {
    throw new Error("expected config write");
  }
  return mocks.writtenConfig as OpenClawConfig;
}

type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;

function mockDefaults(defaults: Defaults) {
  mockConfigSnapshot({ agents: { defaults } });
}

function expectDefaults(defaults: Defaults) {
  expect(getWrittenConfig().agents).toEqual({ defaults });
}

function expectWrittenPrimaryModel(model: string) {
  expectDefaults({ model: { primary: model }, models: { [model]: {} } });
}

const fallbackGroups = [
  { name: "fallbacks", key: "model", label: "Fallbacks", singular: "Fallback" },
  {
    name: "image-fallbacks",
    key: "imageModel",
    label: "Image fallbacks",
    singular: "Image fallback",
  },
] as const;

async function runFallbackCommand(name: string, ...args: string[]) {
  await runRegisteredCli({ register: registerModelsCli, argv: ["models", name, ...args] });
}

describe("models set + fallbacks", () => {
  beforeEach(() => {
    mockConfigSnapshot();
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["z.ai/glm-4.7", "zai/glm-4.7", false],
    ["openai/gpt-5.6-sol", "openai/gpt-5.6-sol", true],
  ] as const)("sets %s as %s", async (input, expected, checkWarnings) => {
    await modelsSetCommand(input, runtime);
    expectWrittenPrimaryModel(expected);
    if (checkWarnings) {
      expect(runtime.error).not.toHaveBeenCalled();
    }
  });

  it("rejects an unknown text model provider without writing config", async () => {
    await expect(
      modelsSetCommand("no-such-provider/no-such-model", runtime, "model"),
    ).rejects.toThrow('Unknown model provider "no-such-provider"');
    expect(mocks.writtenConfig).toBeUndefined();
  });

  it("warns but saves an unknown image model for a known provider", async () => {
    await modelsSetCommand("openai/not-in-the-local-catalog", runtime, "imageModel");
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Model "openai/not-in-the-local-catalog" is not in the local model catalog',
      ),
    );
    expect(getWrittenConfig().agents?.defaults?.models).toHaveProperty(
      "openai/not-in-the-local-catalog",
    );
  });

  it("recognizes a provider declared by a disabled installed plugin", async () => {
    mockConfigSnapshot({ plugins: { entries: { ollama: { enabled: false } } } });
    await modelsSetCommand("ollama/site-local-model", runtime);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('Provider "ollama" has no local model catalog'),
    );
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("verify the model ID"));
    expect(getWrittenConfig().agents?.defaults?.models).toHaveProperty("ollama/site-local-model");
  });

  it("normalizes z-ai provider in models fallbacks add", async () => {
    const { name, key, label } = fallbackGroups[0];
    mockDefaults({ [key]: { fallbacks: [] } });
    await runFallbackCommand(name, "add", "z-ai/glm-4.7");
    expectDefaults({ [key]: { fallbacks: ["zai/glm-4.7"] }, models: { "zai/glm-4.7": {} } });
    expect(defaultRuntime.log).toHaveBeenLastCalledWith(`${label}: zai/glm-4.7`);
  });

  it("does not duplicate a provider alias in models image-fallbacks add", async () => {
    const { name, key } = fallbackGroups[1];
    mockDefaults({ [key]: { fallbacks: ["moonshotai/kimi-k3"] } });
    await runFallbackCommand(name, "add", "moonshot/kimi-k3");
    expect(getWrittenConfig().agents?.defaults?.[key]).toEqual({
      fallbacks: ["moonshotai/kimi-k3"],
    });
  });

  it.each(fallbackGroups)(
    "removes aliases and clears only models $name",
    async ({ name, key, label, singular }) => {
      const siblingKey = key === "model" ? "imageModel" : "model";
      const primary = "openai/gpt-5.6-luna";
      const sibling = { primary, fallbacks: [primary] };
      mockDefaults({
        [key]: { primary, fallbacks: ["backup", primary] },
        [siblingKey]: sibling,
        models: { "zai/glm-4.7": { alias: "backup" } },
      });
      await runFallbackCommand(name, "remove", "z-ai/glm-4.7");
      expect(getWrittenConfig().agents?.defaults?.[key]).toEqual({ primary, fallbacks: [primary] });
      expect(getWrittenConfig().agents?.defaults?.[siblingKey]).toEqual(sibling);
      expect(defaultRuntime.log).toHaveBeenLastCalledWith(`${label}: ${primary}`);
      mocks.currentConfig = getWrittenConfig();
      await runFallbackCommand(name, "clear");
      expect(getWrittenConfig().agents?.defaults?.[key]).toEqual({ primary, fallbacks: [] });
      expect(getWrittenConfig().agents?.defaults?.[siblingKey]).toEqual(sibling);
      expect(defaultRuntime.log).toHaveBeenLastCalledWith(`${singular} list cleared.`);
      mockConfigSnapshot(getWrittenConfig());
      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
        throw new Error("CLI exit");
      });
      await expect(runFallbackCommand(name, "remove", "backup")).rejects.toThrow("CLI exit");
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`${singular} not found: zai/glm-4.7.`),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`models ${name} list`));
      expect(exit).toHaveBeenCalledWith(1);
      expect(mocks.writtenConfig).toBeUndefined();
    },
  );

  it("migrates legacy duplicated OpenRouter keys on write", async () => {
    const model = "openrouter/hunter-alpha";
    const params = { thinking: "high" };
    mockDefaults({ models: { "openrouter/openrouter/hunter-alpha": { params } } });
    await modelsSetCommand(model, runtime);
    expectDefaults({ model: { primary: model }, models: { [model]: { params } } });
  });
});
