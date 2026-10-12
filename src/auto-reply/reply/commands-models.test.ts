import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import { bindPreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ProviderCatalogOutcome } from "../../plugins/provider-catalog-outcome.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { buildPreparedModelsProviderData } from "./commands-models-catalog.js";
import { handleModelsCommand } from "./commands-models.js";
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

// mock-isolation: Model browsing uses fixture auth availability without host profile or CLI key reads.
vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabelAsync: () => undefined,
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
  vi.stubEnv("CODEX_API_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", undefined);
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
      bindPreparedModelRuntimeAuth(owner, { store: authStore });
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
  it("reports each model's configured runtime regardless of the session runtime pin", async () => {
    setCredentials(["anthropic", "claude-cli"]);
    const data = await buildPreparedModelsProviderData(
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
            models: {
              "anthropic/claude-opus-4-5": { agentRuntime: { id: "openclaw" } },
              "anthropic/claude-sonnet-4-5": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      "main",
      {
        sessionEntry: {
          providerOverride: "anthropic",
          model: "claude-sonnet-4-5",
          agentRuntimeOverride: "openclaw",
        },
      },
    );
    expect(data.runtimeChoicesByModel?.get("anthropic/claude-sonnet-4-5")?.length).toBe(2);
    expect(data.modelRuntimeIds?.get("anthropic/claude-sonnet-4-5")).toBe("claude-cli");
    expect(data.modelRuntimeIds?.get("anthropic/claude-opus-4-5")).toBe("openclaw");
  });

  it("labels the default route after clearing the session runtime pin", async () => {
    setCredentials(["anthropic", "claude-cli"]);
    const data = await buildPreparedModelsProviderData(
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
            models: {
              "anthropic/claude-opus-4-5": { agentRuntime: { id: "openclaw" } },
              "anthropic/claude-sonnet-4-5": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      "main",
      {
        sessionEntry: {
          providerOverride: "anthropic",
          model: "claude-sonnet-4-5",
          agentRuntimeOverride: "claude-cli",
        },
      },
    );
    expect(data.modelMenu?.modelNames.get("anthropic/claude-opus-4-5")).toMatch(/^API\b/);
    expect(data.modelMenu?.modelNames.get("anthropic/claude-sonnet-4-5")).toMatch(/^Claude CLI\b/);
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
    expect(allListResult?.reply?.text).toContain("Switch: /model <provider/model>");
  });

  it.each([{ provider: "anthropic", recovery: "Connect with /login anthropic." }])(
    "offers supported setup for an unauthenticated $provider",
    async ({ provider, recovery }) => {
      setCredentials([]);
      modelCatalogMocks.loadModelCatalog.mockReturnValue([]);
      const params = buildParams(`/models ${provider}`, {
        agents: { defaults: { model: { primary: `${provider}/chat` } } },
      });
      const result = await handleModelsCommand(params, true);
      expect(result?.reply?.text).toContain("Sign-in needed");
      expect(result?.reply?.text).toContain(recovery);
    },
  );

  it("reports sign-in needed for a logged-out configured CLI runtime", async () => {
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
    expect(result?.reply?.text).toContain("Sign-in needed");
    expect(result?.reply?.text).toContain(
      "If Claude Code is signed out, run claude auth login on the Gateway host, or choose another model.",
    );
    expect(result?.reply?.text).not.toContain("/login anthropic");
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

  it.each(["default"] as const)("retains selected route metadata for %s browse", async (view) => {
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

  it.each([
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
    expect(result?.reply?.channelData).toEqual(channelData);
  });

  it.each(["/models openai page=2next limit=1x"])(
    "lists models without coercing malformed tokens: %s",
    async (command) => {
      const result = await handleModelsCommand(buildParams(command), true);
      expect(result?.reply?.text).toContain("Models (openai) — showing 1-2 of 2 (page 1/1)");
      expect(result?.reply?.text).toContain("- openai/gpt-4.1");
      expect(result?.reply?.text).toContain("- openai/gpt-4.1-mini");
      expect(result?.reply?.text).toContain("Switch: /model <provider/model>");
    },
  );

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

  it.each(["/models add"])("returns a deprecation message for %s", async (command) => {
    const result = await handleModelsCommand(buildParams(command), true);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: MODELS_ADD_DEPRECATED_TEXT },
    });
  });
});
