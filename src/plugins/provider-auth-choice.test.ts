// Covers provider auth choice selection for plugin-owned providers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { ProviderPlugin } from "./types.js";

const ensureCodexRuntimePluginForModelSelection = vi.hoisted(() => vi.fn());
vi.mock("../commands/codex-runtime-plugin-install.js", () => ({
  CODEX_RUNTIME_PLUGIN_ID: "codex",
  ensureCodexRuntimePluginForModelSelection,
}));

const ensureCopilotRuntimePluginForModelSelection = vi.hoisted(() => vi.fn());
vi.mock("../commands/copilot-runtime-plugin-install.js", () => ({
  ensureCopilotRuntimePluginForModelSelection,
}));

const offerPostInstallMigrations = vi.hoisted(() => vi.fn());
vi.mock("../wizard/setup.post-install-migration.js", () => ({
  offerPostInstallMigrations,
}));

const { testing, applyAuthChoicePluginProvider } = await import("./provider-auth-choice.js");

function buildProvider(defaultModel = "gpt-5.5"): ProviderPlugin {
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
          defaultModel,
        })),
      },
    ],
  };
}

describe("applyAuthChoicePluginProvider", () => {
  beforeEach(() => {
    testing.resetDepsForTest();
    ensureCodexRuntimePluginForModelSelection.mockReset();
    ensureCopilotRuntimePluginForModelSelection.mockReset();
    ensureCopilotRuntimePluginForModelSelection.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg,
        required: false,
        installed: false,
      }),
    );
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
        opts: { acknowledgeNonClawHubInstall: true },
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
    expect(ensureCodexRuntimePluginForModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        acknowledgeNonClawHubInstall: true,
      }),
    );
    expect(ensureCopilotRuntimePluginForModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        acknowledgeNonClawHubInstall: true,
      }),
    );
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

  it("keeps the previous default model when Codex runtime install is declined", async () => {
    const provider = buildProvider("openai/gpt-5.5");
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
        cfg,
        required: true,
        installed: false,
        status: "failed",
      }),
    );

    const result = await applyAuthChoicePluginProvider(
      {
        authChoice: "openai-api-key",
        config: { agents: { defaults: { model: { primary: "ollama/llama3" } } } },
        runtime: createNonExitingRuntime(),
        prompter: createWizardPrompter(),
        setDefaultModel: true,
        opts: {},
      },
      {
        authChoice: "openai-api-key",
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        label: "OpenAI",
      },
    );

    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(ensureCopilotRuntimePluginForModelSelection).not.toHaveBeenCalled();
    expect(offerPostInstallMigrations).not.toHaveBeenCalled();
    expect(result?.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3" });
  });

  it("keeps the previous default model when Copilot runtime install is declined", async () => {
    const provider = buildProvider("github-copilot/gpt-5.5");
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
        cfg,
        required: false,
        installed: false,
      }),
    );
    ensureCopilotRuntimePluginForModelSelection.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg,
        required: true,
        installed: false,
        status: "failed",
      }),
    );

    const result = await applyAuthChoicePluginProvider(
      {
        authChoice: "openai-api-key",
        config: { agents: { defaults: { model: { primary: "ollama/llama3" } } } },
        runtime: createNonExitingRuntime(),
        prompter: createWizardPrompter(),
        setDefaultModel: true,
        opts: {},
      },
      {
        authChoice: "openai-api-key",
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        label: "OpenAI",
      },
    );

    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(offerPostInstallMigrations).not.toHaveBeenCalled();
    expect(result?.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3" });
  });
});
