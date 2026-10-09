import { createServer } from "node:http";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { withLoopbackTestServer } from "./loopback-server.test-support.js";

const mocks = vi.hoisted(() => ({
  promptAuthChoiceGrouped: vi.fn(),
  applyAuthChoice: vi.fn(),
  promptModelAllowlist: vi.fn<typeof import("../flows/model-picker.js").promptModelAllowlist>(),
  promptDefaultModel: vi.fn<typeof import("../flows/model-picker.js").promptDefaultModel>(),
  resolvePluginProvidersCore: vi.fn(() => []),
  resolveProviderPluginChoiceCore: vi.fn<() => unknown>(() => null),
  loadStaticManifestCatalogRowsForList: vi.fn<() => readonly NormalizedModelCatalogRow[]>(() => []),
  resolvePreferredProviderForAuthChoice: vi.fn<() => Promise<string | undefined>>(
    async () => undefined,
  ),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  persistAuthProfileBatch: vi.fn(async () => {}),
  ensureAuthProfileStore: vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
}));

vi.mock("./auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped: mocks.promptAuthChoiceGrouped,
}));

vi.mock("./auth-choice.apply.js", () => ({
  applyAuthChoice: mocks.applyAuthChoice,
}));

vi.mock("../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice: mocks.resolvePreferredProviderForAuthChoice,
}));

vi.mock("../flows/model-picker.js", async (importOriginal) => {
  const { applyModelAllowlist, applyModelFallbacksFromSelection } =
    await importOriginal<typeof import("../flows/model-picker.js")>();
  return {
    applyModelAllowlist,
    applyModelFallbacksFromSelection,
    promptModelAllowlist: mocks.promptModelAllowlist,
    promptDefaultModel: mocks.promptDefaultModel,
  };
});

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoiceCore: mocks.resolveProviderPluginChoiceCore,
}));

vi.mock("./models/list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList: mocks.loadStaticManifestCatalogRowsForList,
}));

import { promptAuthConfig } from "./configure.gateway-auth.js";

const { applyAuthChoice: applyProviderAuthChoice } =
  await vi.importActual<typeof import("./auth-choice.apply.js")>("./auth-choice.apply.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);
  mocks.resolveProviderPluginChoiceCore.mockReturnValue(null);
  // These provider fixtures expose no CLI backends; policy checks need no plugin discovery.
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [],
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
  });
  mocks.loadStaticManifestCatalogRowsForList.mockReturnValue([]);
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

const makeRuntime = (): RuntimeEnv => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

const promptModelAllowlistOptions = () => mocks.promptModelAllowlist.mock.calls[0]?.[0];
const noopPrompter = {} as WizardPrompter;
const target = { agentId: "ops", agentDir: "/tmp/ops-agent", workspaceDir: "/tmp/ops-workspace" };

function createTestModel(id: string, name = id) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"] as Array<"text" | "image" | "video" | "audio">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function providerModels(id: string) {
  return {
    baseUrl: "https://provider.example/v1",
    api: "openai-completions" as const,
    models: [createTestModel(id)],
  };
}

function agentConfig(
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"],
  model?: AgentModelConfig,
  explicit = true,
  others: NonNullable<OpenClawConfig["agents"]>["entries"] = { main: {} },
): OpenClawConfig {
  return {
    agents: {
      ...(explicit ? { ownership: "explicit" } : {}),
      defaults: { systemAgent: { agentId: "ops" }, ...defaults },
      entries: { ...others, OPS: { model } },
    },
  };
}

describe("promptAuthConfig", () => {
  it("resolves fallback aliases before scoped allowlist pruning", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("token");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["mini"],
            },
            models: {
              "openai/gpt-5.5": { alias: "GPT" },
              "openai/gpt-5.4-mini": { alias: "mini" },
              "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
    });
    mocks.resolveProviderPluginChoiceCore.mockReturnValue({
      provider: {
        id: "openai",
        label: "OpenAI",
        auth: [],
        wizard: {
          setup: {
            modelAllowlist: {
              allowedKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
            },
          },
        },
      },
      method: { id: "setup-token", label: "setup-token", kind: "token" },
    });

    const result = await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(result.agents?.defaults?.modelPolicy?.allow).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.5",
    ]);
    expect(result.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(result.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "GPT" },
      "openai/gpt-5.4-mini": { alias: "mini" },
      "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
    });
  });

  it("canonicalizes a selected agent's legacy Codex primary before updating its allowlist", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("openai-device-code");
    mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue("openai");
    const config = agentConfig(
      { model: { primary: "anthropic/claude-sonnet-4-6" } },
      { primary: "codex/gpt-5.5" },
    );
    mocks.applyAuthChoice.mockResolvedValue({ config });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5"],
    });

    const result = await promptAuthConfig(config, makeRuntime(), noopPrompter, target);

    expect(result.agents?.entries?.OPS?.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(result.agents?.entries?.OPS?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
    expect(result.agents?.defaults?.model).toEqual({ primary: "anthropic/claude-sonnet-4-6" });
  });

  it.each([
    { source: "manifest", provider: "github-copilot", preferred: "github-copilot", scoped: false },
    { source: "configured", provider: "ollama", preferred: undefined, scoped: true },
  ])(
    "loads the $source catalog after provider setup",
    async ({ source, provider, preferred, scoped }) => {
      const existingConfig: OpenClawConfig = {
        models: { providers: { existing: providerModels("old") } },
      };
      mocks.promptAuthChoiceGrouped.mockResolvedValue(provider);
      mocks.resolvePreferredProviderForAuthChoice.mockResolvedValue(preferred);
      mocks.applyAuthChoice.mockResolvedValue({
        config:
          source === "manifest"
            ? { ...existingConfig, plugins: { entries: { [provider]: { enabled: true } } } }
            : {
                models: {
                  providers: {
                    ...existingConfig.models?.providers,
                    [provider]: providerModels("new"),
                  },
                },
              },
      });
      if (source === "manifest") {
        mocks.loadStaticManifestCatalogRowsForList.mockReturnValueOnce([
          {
            ref: `${provider}/new`,
            mergeKey: `${provider}/new`,
            provider,
            id: "new",
            name: "New",
            source: "manifest",
            input: ["text"],
            reasoning: false,
            status: "available",
          },
        ]);
      }
      mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });
      await promptAuthConfig(existingConfig, makeRuntime(), noopPrompter);
      expect(mocks.promptModelAllowlist).toHaveBeenCalledOnce();
      expect(promptModelAllowlistOptions()).toMatchObject({
        preferredProvider: provider,
        loadCatalog: true,
        providerScopedCatalog: scoped,
      });
    },
  );

  it("returns to auth selection when plugin install onboarding asks for a retry", async () => {
    mocks.promptAuthChoiceGrouped
      .mockResolvedValueOnce("provider-plugin:wecom:default")
      .mockResolvedValueOnce("kilocode-api-key");
    mocks.applyAuthChoice
      .mockResolvedValueOnce({ config: {}, retrySelection: true })
      .mockResolvedValueOnce({
        config: {
          models: {
            providers: {
              kilocode: providerModels("kilo-auto/balanced"),
              minimax: providerModels("MiniMax-M2.7"),
            },
          },
        },
      });
    mocks.promptModelAllowlist.mockResolvedValue({ models: undefined });
    mocks.resolvePreferredProviderForAuthChoice
      .mockResolvedValueOnce("wecom")
      .mockResolvedValueOnce(undefined);

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(mocks.applyAuthChoice).toHaveBeenCalledTimes(2);
    expect(mocks.promptModelAllowlist).toHaveBeenCalledTimes(1);
  });

  it("writes model policy to the explicit configure target instead of global defaults", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("skip");
    mocks.promptDefaultModel.mockResolvedValue({ model: "openai/gpt-5.5" });
    mocks.promptModelAllowlist.mockResolvedValue({ models: ["openai/gpt-5.5"] });

    const result = await promptAuthConfig(agentConfig({}), makeRuntime(), noopPrompter, target);

    expect(promptModelAllowlistOptions()?.preferredProvider).toBe("openai");
    expect(result.agents?.entries?.OPS?.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(result.agents?.entries?.OPS?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
    expect(result.agents?.defaults?.model).toBeUndefined();
    expect(result.agents?.defaults?.modelPolicy).toBeUndefined();
    expect(promptModelAllowlistOptions()).toMatchObject({
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
    });
  });

  it.each<
    [
      name: string,
      defaultModel: AgentModelConfig | undefined,
      agentModel: AgentModelConfig | undefined,
      existingPrimary: string | undefined,
      explicit: boolean,
      override: boolean,
    ]
  >([
    ["no recommendation", undefined, undefined, undefined, false, false],
    ["initialize explicit agent", undefined, undefined, undefined, true, true],
    [
      "preserve agent primary",
      { primary: "shared/primary", fallbacks: ["shared/fallback"] },
      { primary: "agent/primary", fallbacks: ["agent/fallback"] },
      "agent/primary",
      true,
      true,
    ],
    ["inherit string primary", "shared/primary", undefined, "shared/primary", true, true],
    ["preserve string primary", undefined, "agent/primary", "agent/primary", true, true],
    [
      "initialize legacy agent",
      undefined,
      { fallbacks: ["agent/fallback"] },
      undefined,
      false,
      true,
    ],
    [
      "initialize shared primary",
      { fallbacks: ["shared/fallback"] },
      undefined,
      undefined,
      false,
      true,
    ],
  ])(
    "provider auth: %s",
    async (_name, defaultModel, agentModel, existingPrimary, explicit, override) => {
      const recommended = "configure-provider/recommended";
      const method: ProviderAuthMethod = {
        id: "api-key",
        label: "Configure provider",
        kind: "api_key",
        run: async () => ({
          profiles: [],
          ...(override ? { defaultModel: recommended } : {}),
          configPatch: {
            agents: {
              defaults: {
                ...(override ? { model: { primary: recommended } } : {}),
                models: { [recommended]: { alias: "Recommended" } },
              },
            },
            models: {
              providers: {
                "configure-provider": providerModels("recommended"),
              },
            },
          },
        }),
      };
      const provider: ProviderPlugin = {
        id: "configure-provider",
        label: "Configure provider",
        auth: [method],
        ...(override
          ? { wizard: { setup: { modelSelection: { promptWhenAuthChoiceProvided: true } } } }
          : {}),
      };
      mocks.promptAuthChoiceGrouped.mockResolvedValue("provider-plugin:configure-provider:api-key");
      mocks.applyAuthChoice.mockImplementationOnce(applyProviderAuthChoice);
      mocks.resolveProviderPluginChoiceCore.mockReturnValue({ provider, method });
      mocks.promptModelAllowlist.mockResolvedValue({
        models: [recommended],
        scopeKeys: [recommended],
      });
      const config = agentConfig(
        {
          model: defaultModel,
          models: { "shared/available": { alias: "Existing" } },
          modelPolicy: { allow: ["shared/available"] },
        },
        agentModel,
        explicit,
      );
      const result = await promptAuthConfig(config, makeRuntime(), noopPrompter, target);

      const initializesPrimary = !existingPrimary && override;
      const initializesAgent = initializesPrimary && (explicit || agentModel !== undefined);
      const expectedAgentModel =
        typeof agentModel === "string" ? { primary: agentModel } : agentModel;
      expect(resolveAgentEffectiveModelPrimary(result, "ops")).toBe(
        existingPrimary ?? (override ? recommended : undefined),
      );
      expect(result.agents?.entries?.OPS?.model).toEqual(
        initializesAgent ? { ...expectedAgentModel, primary: recommended } : expectedAgentModel,
      );
      expect(result.agents?.defaults?.model).toEqual(
        initializesPrimary && !initializesAgent
          ? { ...(typeof defaultModel === "object" ? defaultModel : {}), primary: recommended }
          : defaultModel,
      );
      expect(result.agents?.entries?.OPS?.modelPolicy?.allow).toEqual([
        "shared/available",
        recommended,
      ]);
      expect(result.agents?.defaults?.modelPolicy).toEqual(config.agents?.defaults?.modelPolicy);
      expect(result.agents?.entries?.ops).toBeUndefined();
    },
  );

  it.each<
    [
      name: string,
      explicit: boolean,
      defaultModel: AgentModelConfig | undefined,
      agentModel: AgentModelConfig | undefined,
      expectedModel: AgentModelConfig,
    ]
  >([
    [
      "preserve shared primary",
      false,
      { primary: "openai/gpt-5.6-luna", fallbacks: ["anthropic/sonnet-4.6"] },
      undefined,
      { primary: "openai/gpt-5.6-luna", fallbacks: ["anthropic/sonnet-4.6"] },
    ],
    [
      "initialize shared primary",
      false,
      { fallbacks: ["anthropic/sonnet-4.6"] },
      undefined,
      { primary: "custom/llama3", fallbacks: ["anthropic/sonnet-4.6"] },
    ],
    [
      "inherit shared primary",
      true,
      { primary: "openai/gpt-5.6-luna" },
      { fallbacks: ["anthropic/sonnet-4.6"] },
      { fallbacks: ["anthropic/sonnet-4.6"] },
    ],
    ["initialize agent primary", true, undefined, undefined, { primary: "custom/llama3" }],
  ])("custom provider: %s", async (_name, explicit, defaultModel, agentModel, expectedModel) => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("custom-api-key");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await withLoopbackTestServer(server, async (port) => {
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const prompter: WizardPrompter = {
        intro: vi.fn(),
        outro: vi.fn(),
        note: vi.fn(),
        select: vi.fn().mockResolvedValueOnce("plaintext").mockResolvedValueOnce("openai"),
        multiselect: vi.fn(),
        text: vi
          .fn()
          .mockResolvedValueOnce(baseUrl)
          .mockResolvedValueOnce("")
          .mockResolvedValueOnce("llama3")
          .mockResolvedValueOnce("custom")
          .mockResolvedValueOnce("Custom"),
        confirm: vi.fn().mockResolvedValue(false),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      };

      const config = agentConfig({ model: defaultModel }, agentModel, explicit, {});
      const result = await promptAuthConfig(config, makeRuntime(), prompter, target);

      const modelOwner = explicit ? result.agents?.entries?.OPS : result.agents?.defaults;
      expect(modelOwner?.model).toEqual(expectedModel);
      expect(modelOwner?.models?.["custom/llama3"]).toEqual({ alias: "Custom" });
      if (explicit) {
        expect(result.agents?.defaults?.model).toEqual(defaultModel);
        expect(result.agents?.defaults?.models).toBeUndefined();
      }
      expect(result.models?.providers?.custom).toMatchObject({
        baseUrl,
        api: "openai-completions",
        models: [{ id: "llama3" }],
      });
    });
  });
});
