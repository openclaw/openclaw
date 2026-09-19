import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog-outcome.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { buildPreparedModelsProviderData, handleModelsCommand } from "./commands-models.js";
import {
  createModelsTestRegistry,
  createModelsTestOwner,
  setFastModelsCliBackendDeps,
} from "./commands-models.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

let authStore: AuthProfileStore;
let authModes: PreparedAgentCredentialModes;
let providerOutcomes: ProviderCatalogOutcome[];
const openAIPlatformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
} as const;

function setCredentials(providers: string[]) {
  authStore = {
    version: 1,
    profiles: Object.fromEntries(
      providers.map((provider) => [
        provider,
        { type: "api_key" as const, provider, key: "synthetic-key" },
      ]),
    ),
  };
  authModes = Object.fromEntries(providers.map((provider) => [provider, "api_key" as const]));
}

const modelCatalogMocks = vi.hoisted(() => ({
  loadModelCatalog:
    vi.fn<
      (
        params: Parameters<
          typeof preparedCatalog.loadPublishedPreparedModelCatalogOwnerSnapshot
        >[0],
      ) => ModelCatalogEntry[]
    >(),
}));
const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());
const pluginMetadataMocks = vi.hoisted(() => ({
  getCurrent: vi.fn<() => PluginMetadataSnapshot>(),
}));
const MODELS_ADD_DEPRECATED_TEXT =
  "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: () => undefined,
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrent,
}));

beforeEach(() => {
  vi.spyOn(preparedCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot").mockImplementation(
    async (params) => {
      if (!params?.config) {
        throw new Error("The browse fixture requires its captured config");
      }
      const entries = modelCatalogMocks.loadModelCatalog(params);
      const baseOwner = createModelsTestOwner(params.config, entries, params);
      const owner = {
        ...baseOwner,
        authModes,
        modelCatalog: { ...baseOwner.modelCatalog, providerOutcomes },
        metadataSnapshot: pluginMetadataMocks.getCurrent(),
      };
      setPreparedModelRuntimeAuthStore(owner, authStore);
      return owner;
    },
  );
  setFastModelsCliBackendDeps();
  providerOutcomes = [];
  modelCatalogMocks.loadModelCatalog.mockReset();
  modelCatalogMocks.loadModelCatalog.mockReturnValue([
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    { ...openAIPlatformRoute, provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    { ...openAIPlatformRoute, provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
  ]);
  normalizeProviderModelIdWithRuntimeMock.mockReset();
  pluginMetadataMocks.getCurrent.mockReset().mockReturnValue(
    createPluginMetadataSnapshotFixture({
      plugins: ["anthropic", "xai", "refresh", "access", "cancel", "choice"].map((id) => ({
        id,
        providerAuthChoices: [
          {
            provider: id,
            method: "device-code",
            choiceId: `${id}-device-code`,
            choiceLabel: id,
            appGuidedAuth: "device-code",
            credentialOnly: true,
            channelLogin: {},
          },
        ],
      })),
    }),
  );
  setCredentials(["anthropic", "google", "openai"]);
  setActivePluginRegistry(createModelsTestRegistry());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cliBackendsTesting.resetDepsForTest();
});

function buildParams(
  commandBodyNormalized: string,
  cfgOverrides: Partial<OpenClawConfig> = {},
): HandleCommandsParams {
  return {
    cfg: {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
        },
      },
      commands: {
        text: true,
      },
      ...cfgOverrides,
    } as OpenClawConfig,
    ctx: {
      Surface: "discord",
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "user-1",
      channel: "discord",
      channelId: "channel-1",
      surface: "discord",
      ownerList: [],
      from: "user-1",
      to: "bot",
    },
    sessionKey: "agent:main:discord:direct:user-1",
    workspaceDir: "/tmp",
    provider: "anthropic",
    model: "claude-opus-4-5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
  } as unknown as HandleCommandsParams;
}

describe("handleModelsCommand", () => {
  it("shows the providers published by the prepared owner", async () => {
    pluginMetadataMocks.getCurrent.mockReturnValue(createPluginMetadataSnapshotFixture());
    const result = await handleModelsCommand(buildParams("/models"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Providers:");
    expect(result?.reply?.text).toContain("- anthropic (2)");
    expect(result?.reply?.text).toContain("- google (1)");
    expect(result?.reply?.text).toContain("- openai (2)");
    expect(result?.reply?.text).toContain("Use: /models <provider>");
    expect(result?.reply?.text).toContain("Switch: /model <provider/model>");
    expect(result?.reply?.text).not.toContain("Add: /models add");
  });

  it("hides unauthenticated providers by default and keeps all as explicit browse", async () => {
    setCredentials(["anthropic"]);

    const providersResult = await handleModelsCommand(buildParams("/models"), true);
    expect(providersResult?.reply?.text).toContain("- anthropic (2)");
    expect(providersResult?.reply?.text).not.toContain("- google");
    expect(providersResult?.reply?.text).not.toContain("- openai");

    const defaultListResult = await handleModelsCommand(buildParams("/models openai"), true);
    expect(defaultListResult?.reply?.text).toContain("Unknown provider: openai");

    const allListResult = await handleModelsCommand(buildParams("/models openai all"), true);
    expect(allListResult?.reply?.text).toContain("Models (openai) — showing 1-2 of 2 (page 1/1)");
    expect(allListResult?.reply?.text).toContain("- openai/gpt-4.1");
    expect(allListResult?.reply?.text).toContain("- openai/gpt-4.1-mini");
  });

  it.each([
    { provider: "anthropic", recovery: "Connect with /login anthropic." },
    { provider: "custom-route", recovery: "custom-provider guide" },
  ])("offers supported setup for an unauthenticated $provider", async ({ provider, recovery }) => {
    setCredentials([]);
    modelCatalogMocks.loadModelCatalog.mockReturnValue([]);
    const params = buildParams(`/models ${provider}`, {
      agents: { defaults: { model: { primary: `${provider}/chat` } } },
    });
    const result = await handleModelsCommand(params, true);
    expect(result?.reply?.text).toContain("Sign-in needed");
    expect(result?.reply?.text).toContain(recovery);
  });

  it("offers a connection action for an unconfirmed captured CLI login", async () => {
    setCredentials([]);
    const params = buildParams("/models anthropic", {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-5",
          models: { "anthropic/claude-opus-4-5": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    });
    const result = await handleModelsCommand(params, true);
    expect(result?.reply?.text).toContain("Connection not confirmed");
    expect(result?.reply?.text).toContain(
      "Connect with /login anthropic, or choose another model.",
    );
  });

  it.each([
    {
      failure: "rejected",
      label: "Sign-in failed",
      recovery: "Sign in again with /login anthropic.",
    },
    {
      failure: "cooldown",
      label: "Temporarily unavailable",
      recovery: "Try again later or choose another model.",
    },
  ])("renders captured $failure credential state", async ({ failure, label, recovery }) => {
    setCredentials(["anthropic"]);
    authModes = {};
    if (failure === "rejected") {
      providerOutcomes = [
        { provider: "anthropic", profileId: "anthropic", status: "auth-rejected" },
      ];
    } else {
      authStore.usageStats = {
        anthropic: { cooldownUntil: Date.now() + 60_000, cooldownReason: "rate_limit" },
      };
    }
    const params = buildParams("/models anthropic");
    params.ctx.Surface = "telegram";
    params.command.channel = "telegram";
    params.command.surface = "telegram";
    const result = await handleModelsCommand(params, true);
    expect(result?.reply?.text).toContain(label);
    expect(result?.reply?.text).toContain(recovery);
    params.command.commandBodyNormalized = "/models";
    const menu = await handleModelsCommand(params, true);
    expect(menu?.reply?.channelData).toMatchObject({
      telegram: { buttons: [[{ text: "anthropic", callback_data: "models:anthropic" }]] },
    });
  });

  it.each([true, false])(
    "respects xAI login metadata when its plugin is enabled=%s",
    async (enabled) => {
      setCredentials([]);
      modelCatalogMocks.loadModelCatalog.mockReturnValue([
        { provider: "xai", id: "grok-4", name: "Grok 4" },
      ]);
      const result = await handleModelsCommand(
        buildParams("/models xai", {
          agents: { defaults: { model: { primary: "xai/grok-4" } } },
          plugins: { entries: { xai: { enabled } } },
        }),
        true,
      );

      expect(result?.reply?.text).toContain(
        enabled ? "Connect with /login xai." : "custom-provider guide",
      );
      if (!enabled) {
        expect(result?.reply?.text).not.toContain("/login xai");
      }
    },
  );

  it("does not offer an OpenAI row with a conflicting API and endpoint", async () => {
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);

    const data = await buildPreparedModelsProviderData({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    } as OpenClawConfig);

    expect(data.byProvider.has("openai")).toBe(false);
  });

  it.each(["default", "all"] as const)(
    "retains selected route metadata for %s browse",
    async (view) => {
      setCredentials([]);
      authStore.profiles.subscription = {
        provider: "openai",
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 3_600_000,
      };
      const selected: ModelCatalogEntry = {
        provider: "openai",
        id: "gpt-5.5",
        name: "ChatGPT GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        contextWindow: 128_000,
        thinkingLevelMap: { high: "high", xhigh: "xhigh" },
      };
      modelCatalogMocks.loadModelCatalog.mockReturnValue([
        {
          ...selected,
          name: "Platform GPT-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 32_000,
        },
        selected,
      ]);

      const data = await buildPreparedModelsProviderData(
        {
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
        } as OpenClawConfig,
        undefined,
        { view },
      );

      expect(data.byProvider.get("openai")).toEqual(new Set(["gpt-5.5"]));
      expect(data.modelNames.get("openai/gpt-5.5")).toBe("ChatGPT GPT-5.5");
      expect(data.modelCatalog.filter((entry) => entry.provider === "openai")).toEqual([selected]);
    },
  );

  it("shows plugin-normalized allowlist models in browse data", async () => {
    pluginMetadataMocks.getCurrent.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom-model-normalizer",
            modelIdNormalization: {
              providers: {
                custom: { aliases: { legacy: "modern" } },
              },
            },
          },
        ],
      }),
    );
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "custom", id: "modern", name: "Modern" },
    ]);
    setCredentials(["custom"]);
    const data = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "custom/modern" },
          models: { "custom/legacy": {} },
        },
      },
    } as OpenClawConfig);

    expect(data.byProvider.get("custom")).toEqual(new Set(["modern"]));
  });

  it("does not re-add the default provider when provider visibility is restricted", async () => {
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { ...openAIPlatformRoute, provider: "openai", id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
      { ...openAIPlatformRoute, provider: "openai", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      { provider: "vllm", id: "llama-local", name: "Llama Local" },
      { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
    ]);
    setCredentials(["anthropic", "openai", "vllm"]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
            models: {
              "openai/*": {},
              "vllm/*": {},
            },
          },
        },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("- openai (2)");
    expect(result?.reply?.text).toContain("- vllm (2)");
    expect(result?.reply?.text).not.toContain("- anthropic");
  });

  it("hides bare backwards-compat aliases but surfaces supported CLI runtime providers in /models lists", async () => {
    modelCatalogMocks.loadModelCatalog.mockReturnValueOnce([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus" },
      { provider: "google-gemini-cli", id: "gemini-3.1-pro-preview", name: "Gemini Pro" },
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus" },
      { provider: "google", id: "gemini-3.1-pro-preview", name: "Gemini Pro" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);
    setCredentials(["anthropic", "google", "openai", "claude-cli", "google-gemini-cli"]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("- anthropic (1)");
    expect(result?.reply?.text).toContain("- google (1)");
    expect(result?.reply?.text).toContain("- openai (1)");
    expect(result?.reply?.text).toContain("- claude-cli (1)");
    expect(result?.reply?.text).toContain("- google-gemini-cli (1)");
    expect(result?.reply?.text).not.toMatch(/^- codex \(/m);
    expect(result?.reply?.text).not.toMatch(/^- codex-cli \(/m);
  });

  it("sources CLI runtime provider model lists from the catalog", async () => {
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { provider: "claude-cli", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    ]);
    setCredentials(["claude-cli"]);

    const data = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          // User only declared 2 of claude-cli's 3 supported models.
          // For claude-cli this narrowing must be ignored.
          models: {
            "claude-cli/claude-opus-4-6": {},
            "claude-cli/claude-sonnet-4-6": {},
          },
        },
      },
    } as OpenClawConfig);

    expect([...(data.byProvider.get("claude-cli") ?? [])].toSorted()).toEqual([
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ]);
  });

  it.each<{
    agentAllow?: string[];
    allow?: string[];
    expected: string[];
    fallbacks?: string[];
    legacyAllow?: string[];
    name: string;
    primary?: string;
    view?: "all";
  }>([
    { name: "provider wildcards", allow: ["anthropic/*"], expected: [] },
    { name: "exact refs", allow: ["anthropic/claude-sonnet-4-6"], expected: [] },
    {
      name: "an allowed CLI model",
      allow: ["claude-cli/claude-sonnet-4-6"],
      expected: ["claude-sonnet-4-6"],
    },
    {
      name: "CLI provider wildcards",
      allow: ["claude-cli/*"],
      expected: ["claude-sonnet-4-6"],
    },
    {
      name: "a pinned deprecated CLI model",
      allow: ["claude-cli/claude-opus-4-6"],
      expected: ["claude-opus-4-6"],
    },
    {
      name: "an excluded CLI primary",
      allow: ["anthropic/*"],
      primary: "claude-cli/claude-sonnet-4-6",
      expected: [],
    },
    {
      name: "an excluded CLI fallback under provider wildcards",
      allow: ["anthropic/*"],
      fallbacks: ["claude-cli/claude-sonnet-4-6"],
      expected: [],
    },
    {
      name: "configured CLI fallback retention under exact refs",
      allow: ["anthropic/claude-sonnet-4-6"],
      fallbacks: ["claude-cli/claude-sonnet-4-6"],
      expected: ["claude-sonnet-4-6"],
    },
    { name: "an agent restriction", allow: [], agentAllow: ["anthropic/*"], expected: [] },
    {
      name: "an unrestricted agent override",
      allow: ["anthropic/*"],
      agentAllow: [],
      expected: ["claude-opus-4-6", "claude-sonnet-4-6"],
    },
    {
      name: "an empty explicit allowlist",
      allow: [],
      expected: ["claude-opus-4-6", "claude-sonnet-4-6"],
    },
    {
      name: "legacy provider wildcards",
      legacyAllow: ["anthropic/*"],
      expected: ["claude-opus-4-6", "claude-sonnet-4-6"],
    },
    {
      name: "explicit all browse",
      allow: ["anthropic/*"],
      view: "all",
      expected: ["claude-opus-4-6", "claude-sonnet-4-6"],
    },
  ])(
    "honors $name when listing CLI runtime models",
    async ({ agentAllow, allow, expected, fallbacks, legacyAllow, primary, view }) => {
      modelCatalogMocks.loadModelCatalog.mockReturnValue([
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
        { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet (CLI)" },
        {
          provider: "claude-cli",
          id: "claude-opus-4-6",
          name: "Claude Opus (CLI)",
          status: "deprecated",
        },
      ]);
      setCredentials(["anthropic", "claude-cli"]);
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary: primary ?? "anthropic/claude-sonnet-4-6",
              ...(fallbacks ? { fallbacks } : {}),
            },
            ...(allow !== undefined ? { modelPolicy: { allow } } : {}),
            ...(legacyAllow
              ? { models: Object.fromEntries(legacyAllow.map((ref) => [ref, {}])) }
              : {}),
          },
          ...(agentAllow !== undefined
            ? { entries: { main: { modelPolicy: { allow: agentAllow } } } }
            : {}),
        },
      };
      const originalConfig = structuredClone(config);

      const data = await buildPreparedModelsProviderData(config, "main", { view });

      expect([...(data.byProvider.get("claude-cli") ?? [])].toSorted()).toEqual(expected);
      expect(config).toEqual(originalConfig);
    },
  );

  it("does not treat standalone CLI backends as canonical provider aliases", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "acme-cli",
          pluginId: "acme",
          config: { command: "acme" },
          bundleMcp: false,
        },
      ],
    });
    pluginMetadataMocks.getCurrent.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [{ id: "acme", cliBackends: ["acme-cli"] }],
      }),
    );
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "acme-cli", id: "acme-model", name: "Acme Model" },
    ]);
    setCredentials(["anthropic", "acme-cli"]);

    const data = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "anthropic/*": {},
          },
        },
      },
    } as OpenClawConfig);

    expect(data.byProvider.has("acme-cli")).toBe(false);
  });

  it("keeps non-CLI configured provider model lists scoped to user config", async () => {
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "claude-cli", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "minimax", id: "abab-7", name: "Abab 7" },
      { provider: "minimax", id: "abab-6.5", name: "Abab 6.5" },
    ]);
    setCredentials(["anthropic", "claude-cli", "minimax"]);

    const minimaxData = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "claude-cli/claude-opus-4-6": {},
            "minimax/abab-7": {},
          },
        },
      },
    } as OpenClawConfig);
    expect([...(minimaxData.byProvider.get("minimax") ?? [])]).toEqual(["abab-7"]);
  });

  it("does not synthesize claude-cli models when the catalog has no claude-cli entries", async () => {
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    ]);
    setCredentials(["anthropic", "claude-cli"]);

    const result = await handleModelsCommand(
      buildParams("/models claude-cli", {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-7" },
          },
        },
      }),
      true,
    );

    expect(result?.reply?.text).not.toMatch(/^- claude-cli\//m);
  });

  it("hides CLI runtime providers from the picker when the user has no CLI auth", async () => {
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus 4.7 (CLI)" },
      { provider: "codex-cli", id: "gpt-5.5", name: "GPT-5.5 (CLI)" },
      { provider: "google-gemini-cli", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (CLI)" },
    ]);
    setCredentials(["anthropic"]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("- anthropic (");
    expect(result?.reply?.text).not.toMatch(/^- claude-cli \(/m);
    expect(result?.reply?.text).not.toMatch(/^- codex-cli \(/m);
    expect(result?.reply?.text).not.toMatch(/^- google-gemini-cli \(/m);
  });

  it("filters nested provider namespaces with the same prefix policy as enforcement", async () => {
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "clawrouter", id: "anthropic/claude-haiku-4-5", name: "Claude Haiku" },
      { provider: "clawrouter", id: "google/gemini-3.5-flash", name: "Gemini Flash" },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]);
    setCredentials(["clawrouter", "openai"]);

    const data = await buildPreparedModelsProviderData({
      agents: { defaults: { modelPolicy: { allow: ["clawrouter/anthropic/*"] } } },
    } as OpenClawConfig);

    expect(data.providers).toEqual(["clawrouter"]);
    expect([...expectDefined(data.byProvider.get("clawrouter"), "clawrouter models")]).toEqual([
      "anthropic/claude-haiku-4-5",
    ]);
  });

  it.each([
    {
      surface: "telegram",
      channelData: {
        telegram: {
          buttons: [
            [{ text: "anthropic", callback_data: "models:anthropic" }],
            [{ text: "claude-cli", callback_data: "models:claude-cli" }],
            [{ text: "google", callback_data: "models:google" }],
            [{ text: "openai", callback_data: "models:openai" }],
          ],
        },
      },
    },
    {
      surface: "menuonly",
      channelData: {
        menuonly: {
          providerIds: ["anthropic", "claude-cli", "google", "openai"],
          labels: ["anthropic:2", "claude-cli:1", "google:1", "openai:2"],
        },
      },
    },
  ])("keeps the $surface provider picker browse-only", async ({ surface, channelData }) => {
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus (CLI)" },
      { ...openAIPlatformRoute, provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
      { ...openAIPlatformRoute, provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
    ]);
    setCredentials(["anthropic", "claude-cli", "google", "openai"]);
    const params = buildParams("/models");
    params.ctx.Surface = surface;
    params.command.channel = surface;
    params.command.surface = surface;
    const result = await handleModelsCommand(params, true);
    expect(result?.reply?.text).toBe("Select a provider:");
    expect(result?.reply?.channelData).toEqual(channelData);
  });

  it.each([
    "/models openai",
    "/models openai page=2next limit=1x",
    "/models openai 9007199254740992",
  ])("lists models without coercing malformed tokens: %s", async (command) => {
    const result = await handleModelsCommand(buildParams(command), true);
    expect(result?.reply?.text).toContain("Models (openai) — showing 1-2 of 2 (page 1/1)");
    expect(result?.reply?.text).toContain("- openai/gpt-4.1");
    expect(result?.reply?.text).toContain("- openai/gpt-4.1-mini");
    expect(result?.reply?.text).toContain("Switch: /model <provider/model>");
  });

  it("does not list bare fallback models under the default provider when catalog ownership is unique", async () => {
    modelCatalogMocks.loadModelCatalog.mockReturnValue([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ]);
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["deepseek-v4-flash", "deepseek-v4-pro"],
          },
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies Partial<OpenClawConfig>;

    const data = await buildPreparedModelsProviderData(cfg as OpenClawConfig);

    expect([...(data.byProvider.get("openai") ?? [])]).toEqual(["gpt-5.4"]);
    expect([...(data.byProvider.get("deepseek") ?? [])].toSorted()).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("keeps /models list <provider> as an alias", async () => {
    const result = await handleModelsCommand(buildParams("/models list anthropic"), true);

    expect(result?.reply?.text).toContain("Models (anthropic) — showing 1-2 of 2 (page 1/1)");
    expect(result?.reply?.text).toContain("- anthropic/claude-opus-4-5");
  });

  it.each(["/models add", "/models add ollama", "/models add openai gpt-5.5"])(
    "returns a deprecation message for %s",
    async (command) => {
      const result = await handleModelsCommand(buildParams(command), true);
      expect(result).toEqual({
        shouldContinue: false,
        reply: { text: MODELS_ADD_DEPRECATED_TEXT },
      });
    },
  );
});
