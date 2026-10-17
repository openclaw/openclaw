import { beforeEach, describe, expect, it, vi } from "vitest";
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
    log: (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    },
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

function writtenConfig(): OpenClawConfig {
  return mocks.replaceConfigFile.mock.calls[0]?.[0].sourceConfig;
}

beforeEach(() => {
  mocks.readConfigFileSnapshot.mockReset();
  mocks.replaceConfigFile.mockReset().mockResolvedValue(undefined);
  mocks.loadModelsConfig.mockReset();
});

describe("modelsAliasesListCommand", () => {
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
    mocks.loadModelsConfig.mockResolvedValue(
      modelConfig({
        "openai/gpt-5.6-sol": { alias: "zeta" },
        "anthropic/claude-sonnet-4-6": { alias: "alpha" },
      }),
    );
    const runtime = makeRuntime();

    await modelsAliasesListCommand(opts, runtime);

    expect(runtime.logs).toEqual(lines);
  });

  it("preserves safely named prototype aliases in deterministic JSON output", async () => {
    mocks.loadModelsConfig.mockResolvedValue(
      modelConfig({
        "openai/gpt-5.6-sol": { alias: "zeta" },
        "google/gemini-3.1-pro-preview": { alias: "__proto__" },
        "anthropic/claude-sonnet-4-6": { alias: "alpha" },
      }),
    );
    const runtime = makeRuntime();

    await modelsAliasesListCommand({ json: true }, runtime);

    expect(runtime.logs).toHaveLength(1);
    const payload = JSON.parse(runtime.logs[0] ?? "") as {
      aliases: Record<string, string>;
    };
    expect(Object.keys(payload.aliases)).toEqual(
      ["zeta", "__proto__", "alpha"].toSorted((left, right) => left.localeCompare(right)),
    );
    expect(Object.hasOwn(payload.aliases, "__proto__")).toBe(true);
    expect(Reflect.get(payload.aliases, "__proto__")).toBe("google/gemini-3.1-pro-preview");
    expect(payload.aliases.alpha).toBe("anthropic/claude-sonnet-4-6");
    expect(payload.aliases.zeta).toBe("openai/gpt-5.6-sol");
  });
});

describe("modelsAliasesRemoveCommand", () => {
  it("removes every case-colliding alias from an existing config", async () => {
    const cfg = modelConfig({
      "openai/gpt-5.4-mini": { alias: "Fast" },
      "openai/gpt-5.6-sol": { alias: "fast" },
      "anthropic/claude-sonnet-4-6": { alias: "steady" },
    });
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await modelsAliasesRemoveCommand("FAST", makeRuntime());

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    const written = writtenConfig();
    expect(written.agents?.defaults?.models?.["openai/gpt-5.4-mini"]?.alias).toBeUndefined();
    expect(written.agents?.defaults?.models?.["openai/gpt-5.6-sol"]?.alias).toBeUndefined();
    expect(written.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.alias).toBe("steady");
  });

  it("rejects removal of a built-in alias whose target only matches after key normalization", async () => {
    const cfg = modelConfig({ "google/gemini-4": {} });
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await expect(modelsAliasesRemoveCommand("gemini", makeRuntime())).rejects.toThrow(
      /built-in alias for "google\/gemini-4-argon"/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("falls back to 'Alias not found' when the user explicitly disables a built-in via alias: \"\"", async () => {
    const cfg = modelConfig({ "google/gemini-4-argon": { alias: "" } });
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await expect(modelsAliasesRemoveCommand("gemini", makeRuntime())).rejects.toThrow(
      /Alias not found: gemini/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("removes a user alias that shadows a built-in name (user-set wins)", async () => {
    const cfg = modelConfig({ "openai/gpt-5.4-nano": { alias: "gpt-mini" } });
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await modelsAliasesRemoveCommand("gpt-mini", makeRuntime());

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    const written = writtenConfig();
    expect(written.agents?.defaults?.models?.["openai/gpt-5.4-nano"]?.alias).toBeUndefined();
  });
});

describe("modelsAliasesAddCommand", () => {
  it("does not make an unlisted model override invalid on a fresh config", async () => {
    const cfg = {} as OpenClawConfig;
    mocks.loadModelsConfig.mockResolvedValue(cfg);
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await modelsAliasesAddCommand("zippy", "clawrouter/deepseek/deepseek-v4-flash", makeRuntime());

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
    const runtime = makeRuntime();

    await modelsAliasesAddCommand("new-alias", "old-alias", runtime);

    const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
    expect(replaceParams?.baseHash).toBe("current-hash");
    expect(replaceParams?.sourceConfig.agents?.defaults?.models).toEqual({
      "openai/gpt-5.6-sol": { params: { temperature: 0.2 } },
      "anthropic/claude-opus-5": { alias: "new-alias" },
    });
    expect(runtime.logs).toContain("Alias new-alias -> anthropic/claude-opus-5");
  });
});
