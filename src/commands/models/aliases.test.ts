import { beforeEach, expect, it, vi } from "vitest";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig, TransformConfigFileParams } from "../../config/config.js";
import { stampConfigWriteMetadata } from "../../config/io.meta.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  modelsAliasesAddCommand,
  modelsAliasesListCommand,
  modelsAliasesRemoveCommand,
} from "./aliases.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  loadModelsConfig: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  transformConfigFile: async ({ transform }: TransformConfigFileParams<unknown>) => {
    const loaded = await mocks.readConfigFileSnapshot();
    const writeSnapshot = {
      path: "/tmp/openclaw.json",
      parsed: loaded.sourceConfig ?? loaded.config,
      runtimeConfig: loaded.config,
      ...loaded,
    };
    const { nextConfig, result } = await transform(
      writeSnapshot.sourceConfig ?? writeSnapshot.config,
      { snapshot: writeSnapshot, previousHash: writeSnapshot.hash ?? null, attempt: 0 },
      {},
    );
    await mocks.replaceConfigFile({ sourceConfig: nextConfig, baseHash: writeSnapshot.hash });
    return { nextConfig, result };
  },
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: (...args: unknown[]) => mocks.loadModelsConfig(...args),
}));

// Real provider activation is covered by model-selection.runtime.test.ts.
vi.mock("./model-selection.runtime.js", () => ({
  withModelCommandProviderRuntime: (_params: unknown, run: () => unknown) => run(),
}));

function makeRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: () => {},
    exit: () => {},
    logs,
  };
}

function snapshot(sourceConfig: OpenClawConfig) {
  return {
    valid: true,
    hash: "snapshot-hash",
    sourceConfig,
    config: sourceConfig,
    runtimeConfig: sourceConfig,
  };
}

function modelConfig(
  models: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"],
): OpenClawConfig {
  return { agents: { defaults: { models } } };
}

function configure(cfg: OpenClawConfig) {
  mocks.loadModelsConfig.mockResolvedValue(cfg);
  mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));
}

function configureModels(models: Parameters<typeof modelConfig>[0]) {
  configure(modelConfig(models));
}

function writtenConfig(): OpenClawConfig {
  return mocks.replaceConfigFile.mock.calls[0]?.[0].sourceConfig;
}

let runtime: ReturnType<typeof makeRuntime>;

beforeEach(() => {
  runtime = makeRuntime();
  mocks.readConfigFileSnapshot.mockReset();
  mocks.replaceConfigFile.mockReset().mockResolvedValue(undefined);
  mocks.loadModelsConfig.mockReset();
});

it.each(["json", "plain", "text"] as const)(
  "sorts aliases and preserves raw values only in %s output",
  async (format) => {
    const alias = "café\u001b[2J\nforged";
    const target = "openai/model\u001b]0;hidden\u0007\tnext";
    configureModels({
      "openai/z": { alias: "zeta" },
      [target]: { alias },
      "google/g": { alias: "__proto__" },
    });
    await modelsAliasesListCommand({ json: format === "json", plain: format === "plain" }, runtime);
    if (format === "json") {
      expect(runtime.logs).toHaveLength(1);
      const { aliases } = JSON.parse(runtime.logs[0] ?? "");
      expect(Object.keys(aliases)).toEqual(["__proto__", alias, "zeta"]);
      expect(Object.hasOwn(aliases, "__proto__")).toBe(true);
      expect(aliases).toEqual({ ["__proto__"]: "google/g", [alias]: target, zeta: "openai/z" });
    } else {
      const entries = [
        ["__proto__", "google/g"],
        ["café\\nforged", "openai/model\\tnext"],
        ["zeta", "openai/z"],
      ];
      expect(runtime.logs).toEqual(
        format === "plain"
          ? entries.map(([name, model]) => `${name} ${model}`)
          : ["Aliases (3):", ...entries.map(([name, model]) => `- ${name} -> ${model}`)],
      );
    }
  },
);

it("removes every case-colliding user alias even when it shadows a built-in", async () => {
  configureModels({
    "openai/gpt-5.4-mini": { alias: "Gpt-Mini" },
    "openai/gpt-5.6-sol": { alias: "gpt-mini" },
    "anthropic/claude-sonnet-4-6": { alias: "steady" },
  });
  await modelsAliasesRemoveCommand("GPT-MINI", runtime);
  expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
  expect(writtenConfig().agents?.defaults?.models).toEqual({
    "openai/gpt-5.4-mini": { alias: undefined },
    "openai/gpt-5.6-sol": { alias: undefined },
    "anthropic/claude-sonnet-4-6": { alias: "steady" },
  });
});

it.each([
  [
    "normalizes built-in keys",
    { "google/gemini-4": {} },
    /built-in alias for "google\/gemini-4-argon"/,
  ],
  [
    "honors built-in opt-outs",
    { "google/gemini-4-argon": { alias: "" } },
    /Alias not found: gemini/,
  ],
])("rejects removal and %s", async (_label, models, error) => {
  configureModels(models);
  await expect(modelsAliasesRemoveCommand("gemini", runtime)).rejects.toThrow(error);
  expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
});

it("does not make an unlisted model override invalid on a fresh config", async () => {
  const cfg: OpenClawConfig = {};
  configure(cfg);
  await modelsAliasesAddCommand("zippy", "clawrouter/deepseek/deepseek-v4-flash", runtime);
  const written = writtenConfig();
  const persisted = stampConfigWriteMetadata(written, "test", cfg);
  const policy = createModelVisibilityPolicy({
    cfg: persisted,
    catalog: [],
    defaultProvider: "clawrouter",
    defaultModel: "deepseek/deepseek-v4-flash",
  });
  expect(written.agents?.defaults?.modelPolicy).toBeUndefined();
  expect(persisted.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(true);
});

it("resolves alias targets from the CAS-fenced snapshot", async () => {
  const staleCfg = modelConfig({ "openai/gpt-5.6-sol": { alias: "old-alias" } });
  const currentCfg = modelConfig({
    "openai/gpt-5.6-sol": { params: { temperature: 0.2 } },
    "anthropic/claude-opus-5": { alias: "old-alias" },
  });
  mocks.loadModelsConfig.mockResolvedValue(staleCfg);
  mocks.readConfigFileSnapshot.mockResolvedValue({
    ...snapshot(currentCfg),
    hash: "current-hash",
  });
  await modelsAliasesAddCommand("new-alias", "old-alias", runtime);
  const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
  expect(replaceParams?.baseHash).toBe("current-hash");
  expect(replaceParams?.sourceConfig.agents?.defaults?.models).toEqual({
    "openai/gpt-5.6-sol": { params: { temperature: 0.2 } },
    "anthropic/claude-opus-5": { alias: "new-alias" },
  });
  expect(runtime.logs).toContain("Alias new-alias -> anthropic/claude-opus-5");
});
