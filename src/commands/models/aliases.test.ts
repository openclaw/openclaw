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

describe("modelsAliasesListCommand", () => {
  beforeEach(() => {
    mocks.loadModelsConfig.mockReset();
  });

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
    mocks.loadModelsConfig.mockResolvedValue({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": { alias: "zeta" },
            "anthropic/claude-sonnet-4-6": { alias: "alpha" },
          },
        },
      },
    });
    const runtime = makeRuntime();

    await modelsAliasesListCommand(opts, runtime);

    expect(runtime.logs).toEqual(lines);
  });

  it("preserves safely named prototype aliases in deterministic JSON output", async () => {
    mocks.loadModelsConfig.mockResolvedValue({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": { alias: "zeta" },
            "google/gemini-3.1-pro-preview": { alias: "__proto__" },
            "anthropic/claude-sonnet-4-6": { alias: "alpha" },
          },
        },
      },
    });
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
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.replaceConfigFile.mockReset();
    mocks.loadModelsConfig.mockReset();
  });

  it("removes every case-colliding alias from an existing config", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4-mini": { alias: "Fast" },
            "openai/gpt-5.6-sol": { alias: "fast" },
            "anthropic/claude-sonnet-4-6": { alias: "steady" },
          },
        },
      },
    } as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    await modelsAliasesRemoveCommand("FAST", makeRuntime());

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
    const written = replaceParams?.sourceConfig as OpenClawConfig;
    expect(written.agents?.defaults?.models?.["openai/gpt-5.4-mini"]?.alias).toBeUndefined();
    expect(written.agents?.defaults?.models?.["openai/gpt-5.6-sol"]?.alias).toBeUndefined();
    expect(written.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.alias).toBe("steady");
  });

  it("rejects removal of a built-in alias whose target only matches after key normalization", async () => {
    // Source config holds the Gemini 4 shorthand key. applyModelDefaults normalizes
    // `google/gemini-4` to `google/gemini-4-argon` before materializing the `gemini`
    // built-in alias, so `list` shows `gemini`. `remove gemini` must compare against the
    // normalized key and return the actionable built-in error, not "Alias not found".
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "google/gemini-4": {},
          },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await expect(modelsAliasesRemoveCommand("gemini", makeRuntime())).rejects.toThrow(
      /built-in alias for "google\/gemini-4-argon"/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("falls back to 'Alias not found' when the user explicitly disables a built-in via alias: \"\"", async () => {
    // Source config sets an explicit empty alias on the target. applyModelDefaults
    // honors the opt-out (see src/config/defaults.ts:337 and src/config/model-alias-defaults.test.ts:106),
    // so `list` does not show `gemini` and `remove gemini` should return the plain
    // not-found error rather than the "built-in alias" error.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "google/gemini-4-argon": { alias: "" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await expect(modelsAliasesRemoveCommand("gemini", makeRuntime())).rejects.toThrow(
      /Alias not found: gemini/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("removes a user alias that shadows a built-in name (user-set wins)", async () => {
    // User has explicitly set `gpt-mini` as the alias for a different target.
    // applyModelDefaults skips entries with an existing alias, so the user-set
    // alias is what `list` shows and `remove` should remove it normally.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4-nano": { alias: "gpt-mini" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    await modelsAliasesRemoveCommand("gpt-mini", makeRuntime());

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
    const written = replaceParams?.sourceConfig as OpenClawConfig;
    expect(written.agents?.defaults?.models?.["openai/gpt-5.4-nano"]?.alias).toBeUndefined();
  });
});

describe("modelsAliasesAddCommand", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.replaceConfigFile.mockReset();
    mocks.loadModelsConfig.mockReset();
  });

  it("does not make an unlisted model override invalid on a fresh config", async () => {
    const cfg = {} as OpenClawConfig;
    mocks.loadModelsConfig.mockResolvedValue(cfg);
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    await modelsAliasesAddCommand("zippy", "clawrouter/deepseek/deepseek-v4-flash", makeRuntime());

    const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
    const written = replaceParams?.sourceConfig as OpenClawConfig;
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
    const staleCfg = {
      agents: { defaults: { models: { "openai/gpt-5.6-sol": { alias: "old-alias" } } } },
    } as unknown as OpenClawConfig;
    const currentCfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": { params: { temperature: 0.2 } },
            "anthropic/claude-opus-5": { alias: "old-alias" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.loadModelsConfig.mockResolvedValue(staleCfg);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...snapshot(currentCfg),
      hash: "current-hash",
    });
    mocks.replaceConfigFile.mockResolvedValue(undefined);
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
