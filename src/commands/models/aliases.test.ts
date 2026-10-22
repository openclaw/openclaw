import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig, TransformConfigFileParams } from "../../config/config.js";
import { stampConfigWriteMetadata } from "../../config/io.meta.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  modelsAliasesAddCommand,
  modelsAliasesListCommand,
  modelsAliasesRemoveCommand,
} from "./aliases.js";
import { modelsSetCommand } from "./set.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  loadModelsConfig: vi.fn(),
  repairModelSelectionRuntimePlugins: vi.fn(),
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
vi.mock("../runtime-plugin-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-plugin-install.js")>()),
  repairModelSelectionRuntimePlugins: mocks.repairModelSelectionRuntimePlugins,
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
  mocks.repairModelSelectionRuntimePlugins.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

it.each<{
  label: string;
  input: string;
  primary: string;
  source: Parameters<typeof modelConfig>[0];
  resolved: Parameters<typeof modelConfig>[0];
}>([
  {
    label: "runtime-only aliases",
    input: "sonnet",
    primary: "anthropic/claude-sonnet-4-6",
    source: { "anthropic/claude-sonnet-4-6": {} },
    resolved: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
  },
  {
    label: "authored aliases ahead of runtime-only aliases",
    input: "sonnet",
    primary: "openai/gpt-5.5",
    source: { "openai/gpt-5.5": { alias: "sonnet" } },
    resolved: {
      "openai/gpt-5.5": { alias: "sonnet" },
      "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
    },
  },
  {
    label: "manifest-owned provider aliases",
    input: "z.ai/glm-4.7",
    primary: "zai/glm-4.7",
    source: {},
    resolved: {},
  },
])(
  "sets the default using $label and writes only source config",
  async ({ input, primary, source, resolved }) => {
    if (input === "z.ai/glm-4.7") {
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
    }
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...snapshot(modelConfig(source)),
      runtimeConfig: modelConfig(resolved),
      config: modelConfig(resolved),
    });
    await modelsSetCommand(input, runtime);
    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(writtenConfig().agents?.defaults).toEqual({
      model: { primary },
      models: input === "z.ai/glm-4.7" ? { [primary]: {} } : source,
    });
    expect(mocks.repairModelSelectionRuntimePlugins).toHaveBeenCalledWith({
      cfg: writtenConfig(),
      model: primary,
    });
    expect(runtime.logs).toContain(`Default model: ${primary}`);
  },
);

it.each([
  {
    label: "plain",
    opts: { plain: true },
    lines: ["alpha anthropic/claude-sonnet-4-6", "zeta openai/gpt-5.6-sol"],
  },
  {
    label: "human-readable",
    opts: {},
    lines: [
      "Aliases (2):",
      "- alpha -> anthropic/claude-sonnet-4-6",
      "- zeta -> openai/gpt-5.6-sol",
    ],
  },
])("sorts $label aliases independently of model insertion order", async ({ opts, lines }) => {
  configureModels({
    "openai/gpt-5.6-sol": { alias: "zeta" },
    "anthropic/claude-sonnet-4-6": { alias: "alpha" },
  });
  await modelsAliasesListCommand(opts, runtime);
  expect(runtime.logs).toEqual(lines);
});

it("preserves safely named prototype aliases in deterministic JSON output", async () => {
  configureModels({
    "openai/gpt-5.6-sol": { alias: "zeta" },
    "google/gemini-3.1-pro-preview": { alias: "__proto__" },
    "anthropic/claude-sonnet-4-6": { alias: "alpha" },
  });
  await modelsAliasesListCommand({ json: true }, runtime);
  expect(runtime.logs).toHaveLength(1);
  const payload = JSON.parse(runtime.logs[0] ?? "") as { aliases: Record<string, string> };
  expect(Object.keys(payload.aliases)).toEqual(
    ["zeta", "__proto__", "alpha"].toSorted((left, right) => left.localeCompare(right)),
  );
  expect(Object.hasOwn(payload.aliases, "__proto__")).toBe(true);
  expect(payload.aliases).toEqual({
    ["__proto__"]: "google/gemini-3.1-pro-preview",
    alpha: "anthropic/claude-sonnet-4-6",
    zeta: "openai/gpt-5.6-sol",
  });
});

it.each([{}, { plain: true }])("keeps alias reports on one terminal line (%j)", async (opts) => {
  const alias = "café\u001b[2J\nforged";
  const target = "openai/model\u001b]0;hidden\u0007\tnext";
  configureModels({ [target]: { alias } });
  await modelsAliasesListCommand(opts, runtime);
  expect(runtime.logs.join("\n")).toContain("café\\nforged");
  expect(runtime.logs.join("\n")).toContain("openai/model\\tnext");
  for (const control of ["\u001b", "\u0007", "\t"]) {
    expect(runtime.logs.join("\n")).not.toContain(control);
  }
  runtime.logs.length = 0;
  await modelsAliasesListCommand({ json: true }, runtime);
  expect(JSON.parse(runtime.logs[0] ?? "").aliases).toEqual({ [alias]: target });
});

it("removes every case-colliding alias from an existing config", async () => {
  configureModels({
    "openai/gpt-5.4-mini": { alias: "Fast" },
    "openai/gpt-5.6-sol": { alias: "fast" },
    "anthropic/claude-sonnet-4-6": { alias: "steady" },
  });
  await modelsAliasesRemoveCommand("FAST", runtime);
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

it("removes a user alias that shadows a built-in name (user-set wins)", async () => {
  configureModels({ "openai/gpt-5.4-nano": { alias: "gpt-mini" } });
  await modelsAliasesRemoveCommand("gpt-mini", runtime);
  expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
  const written = writtenConfig();
  expect(written.agents?.defaults?.models?.["openai/gpt-5.4-nano"]?.alias).toBeUndefined();
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
