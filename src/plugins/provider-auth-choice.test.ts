import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

const ensureCodexRuntimePluginForModelSelection = vi.hoisted(() => vi.fn());
vi.mock("../commands/codex-runtime-plugin-install.js", () => ({
  CODEX_RUNTIME_PLUGIN_ID: "codex",
  ensureCodexRuntimePluginForModelSelection,
}));

const offerPostInstallMigrations = vi.hoisted(() => vi.fn());
vi.mock("../wizard/setup.post-install-migration.js", () => ({
  offerPostInstallMigrations,
}));

const { testing, applyAuthChoicePluginProvider, runProviderPluginAuthMethod } =
  await import("./provider-auth-choice.js");

function buildProvider(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    auth: [
      {
        id: "api-key",
        label: "API key",
        kind: "api_key",
        run: vi.fn(async () => ({
          profiles: [],
          notes: [],
          defaultModel: "gpt-5.5",
        })),
      },
    ],
  };
}

describe("applyAuthChoicePluginProvider", () => {
  beforeEach(() => {
    testing.resetDepsForTest();
    ensureCodexRuntimePluginForModelSelection.mockReset();
    offerPostInstallMigrations.mockReset();
  });

  it("returns post-install Codex migration config when setting an OpenAI default model", async () => {
    const provider = buildProvider();
    const runProviderModelSelectedHook = vi.fn(async () => undefined);
    testing.setDepsForTest({
      loadPluginProviderRuntime: async () =>
        ({
          resolvePluginProviders: () => [provider],
          runProviderModelSelectedHook,
        }) as never,
    });
    ensureCodexRuntimePluginForModelSelection.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        installed: true,
        cfg: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: {
              ...cfg.plugins?.entries,
              codex: { enabled: true },
            },
          },
        },
      }),
    );
    offerPostInstallMigrations.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => ({
        config: {
          ...config,
          plugins: {
            ...config.plugins,
            entries: {
              ...config.plugins?.entries,
              codex: {
                enabled: true,
                config: {
                  codexPlugins: {
                    enabled: true,
                    allow_destructive_actions: true,
                    plugins: {
                      gmail: {
                        enabled: true,
                        marketplaceName: "openai-curated",
                        pluginName: "gmail",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    const result = await applyAuthChoicePluginProvider(
      {
        authChoice: "openai-api-key",
        config: {},
        runtime: createNonExitingRuntime(),
        prompter: createWizardPrompter(),
        setDefaultModel: true,
      },
      {
        authChoice: "openai-api-key",
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        label: "OpenAI",
      },
    );

    expect(runProviderModelSelectedHook).toHaveBeenCalledOnce();
    expect(offerPostInstallMigrations).toHaveBeenCalledWith(
      expect.objectContaining({
        installedPluginIds: ["codex"],
      }),
    );
    const resultConfig = result?.config;
    expect(resultConfig?.agents?.defaults?.model).toEqual({ primary: "gpt-5.5" });
    const codexConfig = resultConfig?.plugins?.entries?.codex?.config as
      | { codexPlugins?: { plugins?: unknown } }
      | undefined;
    expect(codexConfig?.codexPlugins?.plugins).toEqual({
      gmail: {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "gmail",
      },
    });
  });

  it("applies deferred auth config patches without replaying unchanged config", async () => {
    const baseConfig = {
      channels: {
        telegram: {
          allowFrom: ["old-owner"],
        },
      },
    } satisfies OpenClawConfig;
    const method = {
      id: "api-key",
      label: "API key",
      kind: "api_key",
      run: vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
        profiles: [],
        configPatch: {
          ...config,
          models: {
            ...config.models,
            providers: {
              ...config.models?.providers,
              openai: { models: [] },
            },
          },
        },
      })),
    } satisfies ProviderAuthMethod;

    const result = await runProviderPluginAuthMethod({
      config: baseConfig,
      runtime: createNonExitingRuntime(),
      prompter: createWizardPrompter(),
      method,
    });
    const nextConfig = result.applyToConfig({
      ...baseConfig,
      channels: {
        telegram: {
          allowFrom: ["new-owner"],
        },
      },
    });

    expect(nextConfig.channels?.telegram?.allowFrom).toEqual(["new-owner"]);
    expect(nextConfig.models?.providers?.openai).toEqual({ models: [] });
  });

  it("preserves replaceDefaultModels removals in deferred auth config patches", async () => {
    const method = {
      id: "local",
      label: "Local",
      kind: "custom",
      run: vi.fn(async () => ({
        profiles: [],
        configPatch: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4-6": {},
              },
            },
          },
        },
        replaceDefaultModels: true,
      })),
    } satisfies ProviderAuthMethod;

    const result = await runProviderPluginAuthMethod({
      config: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
              "claude-cli/claude-sonnet-4-6": {},
            },
          },
        },
      },
      runtime: createNonExitingRuntime(),
      prompter: createWizardPrompter(),
      method,
    });
    const nextConfig = result.applyToConfig({
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "claude-cli/claude-sonnet-4-6": {},
            "openai/gpt-5.5": {},
          },
        },
      },
    });

    expect(nextConfig.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": {},
    });
  });
});
