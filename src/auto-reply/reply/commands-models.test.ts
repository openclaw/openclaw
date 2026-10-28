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
import { buildCommandTestParams } from "./commands.test-harness.js";

let authStore: AuthProfileStore;
let authModes: PreparedAgentCredentialModes;
let providerOutcomes: ProviderCatalogOutcome[];
let catalog: ModelCatalogEntry[];
let metadataSnapshot: PluginMetadataSnapshot;
const openAIPlatformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
} as const;
const defaultCatalog: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
  { ...openAIPlatformRoute, provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
  { ...openAIPlatformRoute, provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
  { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
];
type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];

function configWithDefaults(defaults: AgentDefaults = {}): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" }, ...defaults } },
  };
}

function cliConfig(runtime = "claude-cli", defaults: AgentDefaults = {}) {
  return configWithDefaults({
    model: "anthropic/claude-opus-4-5",
    models: { "anthropic/claude-opus-4-5": { agentRuntime: { id: runtime } } },
    ...defaults,
  });
}

function cliCatalog(extra: ModelCatalogEntry[] = []) {
  catalog = [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
    { provider: "claude-cli", id: "claude-opus-4-5", name: "Claude Opus (CLI)" },
    ...extra,
  ];
  setCredentials(["anthropic", "claude-cli"]);
}

function expectText(text: string | undefined, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}

function expectOpenAIList(text: string | undefined) {
  expectText(
    text,
    "Models (openai) — showing 1-2 of 2 (page 1/1)",
    "- openai/gpt-4.1",
    "- openai/gpt-4.1-mini",
    "Switch: /model <provider/model>",
  );
}

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

const MODELS_ADD_DEPRECATED_TEXT =
  "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";

// mock-isolation: Model browsing uses fixture auth availability without host profile or CLI key reads.
vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabelAsync: () => undefined,
}));

// mock-isolation: Model browsing must not load host provider runtimes.
vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => metadataSnapshot,
}));

beforeEach(() => {
  vi.stubEnv("CODEX_API_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.spyOn(preparedCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot").mockImplementation(
    async (params) => {
      if (!params?.config) {
        throw new Error("The browse fixture requires its captured config");
      }
      const baseOwner = createModelsTestOwner(params.config, catalog, params);
      const owner = {
        ...baseOwner,
        authModes,
        modelCatalog: { ...baseOwner.modelCatalog, providerOutcomes },
        metadataSnapshot,
      };
      bindPreparedModelRuntimeAuth(owner, { store: authStore });
      return owner;
    },
  );
  setFastModelsCliBackendDeps();
  providerOutcomes = [];
  catalog = [...defaultCatalog];
  metadataSnapshot = createPluginMetadataSnapshotFixture({
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
  });
  setCredentials(["anthropic", "google", "openai"]);
  setActivePluginRegistry(createModelsTestRegistry());
});

afterEach(() => {
  vi.restoreAllMocks();
  cliBackendsTesting.resetDepsForTest();
});

function runModels(command: string, defaults?: AgentDefaults, surface = "discord") {
  const cfg = { ...configWithDefaults(defaults), commands: { text: true } };
  const params = buildCommandTestParams(command, cfg, {
    Provider: surface,
    Surface: surface,
    From: "user-1",
    To: "bot",
  });
  return handleModelsCommand(
    {
      ...params,
      provider: "anthropic",
      model: "claude-opus-4-5",
      sessionKey: "agent:main:discord:direct:user-1",
    },
    true,
  );
}

describe("handleModelsCommand", () => {
  it("preserves the CLI route allowed by a role policy", async () => {
    cliCatalog();
    const config = cliConfig();
    config.gateway = {
      roles: {
        definitions: {
          cli: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read"],
            modelPolicy: { allow: ["claude-cli/*"] },
          },
        },
      },
    };
    const data = await buildPreparedModelsProviderData(config, "main");
    expect(data.providers).toEqual(["anthropic", "claude-cli"]);
    expect(data.byProvider.get("anthropic")).toEqual(new Set(["claude-opus-4-5"]));
  });

  it("restores the CLI choice when its canonical twin is no longer available", async () => {
    cliCatalog();
    const config = cliConfig();
    const available = await buildPreparedModelsProviderData(config, "main");
    expect(available.providers).toEqual(["anthropic"]);

    // Canonical provider discovery failed auth; the independent CLI account remains usable.
    providerOutcomes = [{ provider: "anthropic", status: "auth-rejected" }];
    const unavailable = await buildPreparedModelsProviderData(config, "main");
    expect(unavailable.providers).toEqual(["anthropic", "claude-cli"]);
    expect(unavailable.modelMenu?.byProvider.get("anthropic")?.available).toBe(0);
    expect(unavailable.modelMenu?.byProvider.get("claude-cli")?.available).toBe(1);
  });

  it("keeps the only allowed CLI route even when the canonical default is configured", async () => {
    cliCatalog();
    setCredentials(["claude-cli"]);
    const data = await buildPreparedModelsProviderData(
      cliConfig("claude-cli", { modelPolicy: { allow: ["claude-cli/*"] } }),
    );
    expect(data.providers).toEqual(["claude-cli"]);
  });

  it("retains a distinct model under the CLI provider after removing its equivalent twin", async () => {
    cliCatalog([{ provider: "claude-cli", id: "claude-sonnet-4-5", name: "Claude Sonnet (CLI)" }]);
    const data = await buildPreparedModelsProviderData(cliConfig());
    expect(data.byProvider.get("claude-cli")).toEqual(new Set(["claude-sonnet-4-5"]));
  });

  it("labels the default route after clearing the session runtime pin", async () => {
    setCredentials(["anthropic", "claude-cli"]);
    const data = await buildPreparedModelsProviderData(
      configWithDefaults({
        models: {
          "anthropic/claude-opus-4-5": { agentRuntime: { id: "openclaw" } },
          "anthropic/claude-sonnet-4-5": { agentRuntime: { id: "claude-cli" } },
        },
      }),
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

    const providersResult = await runModels("/models");
    expect(providersResult?.reply?.text).toContain("- anthropic (2)");
    expect(providersResult?.reply?.text).not.toContain("- google");
    expect(providersResult?.reply?.text).not.toContain("- openai");

    const defaultListResult = await runModels("/models openai");
    expect(defaultListResult?.reply?.text).toContain("Unknown provider: openai");

    const allListResult = await runModels("/models openai all");
    expectOpenAIList(allListResult?.reply?.text);
  });

  it("offers supported setup for unauthenticated anthropic", async () => {
    setCredentials([]);
    catalog = [];
    const result = await runModels("/models anthropic", { model: { primary: "anthropic/chat" } });
    expectText(result?.reply?.text, "Sign-in needed", "Connect with /login anthropic.");
  });

  it("reports sign-in needed for a logged-out configured CLI runtime", async () => {
    setCredentials([]);
    const result = await runModels("/models anthropic", cliConfig().agents?.defaults);
    expectText(
      result?.reply?.text,
      "Sign-in needed",
      "If Claude Code is signed out, run claude auth login on the Gateway host, or choose another model.",
    );
    expect(result?.reply?.text).not.toContain("/login anthropic");
  });

  it.each([
    ["rejected", "Sign-in failed", "Sign in again with /login anthropic."],
    ["cooldown", "Temporarily unavailable", "Try again later or choose another model."],
  ])("renders captured %s credential state", async (failure, label, recovery) => {
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
    const result = await runModels("/models anthropic", {}, "telegram");
    expectText(result?.reply?.text, label, recovery);
    const menu = await runModels("/models", {}, "telegram");
    expect(menu?.reply?.channelData).toMatchObject({
      telegram: { buttons: [[{ text: "anthropic", callback_data: "models:anthropic" }]] },
    });
  });

  it("does not offer an OpenAI row with a conflicting API and endpoint", async () => {
    catalog = [
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    ];

    const data = await buildPreparedModelsProviderData(configWithDefaults());

    expect(data.byProvider.has("openai")).toBe(false);
  });

  it("does not re-add the default provider when provider visibility is restricted", async () => {
    catalog = [
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { ...openAIPlatformRoute, provider: "openai", id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
      { ...openAIPlatformRoute, provider: "openai", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      { provider: "vllm", id: "llama-local", name: "Llama Local" },
      { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
    ];
    setCredentials(["anthropic", "openai", "vllm"]);

    const result = await runModels("/models", { models: { "openai/*": {}, "vllm/*": {} } });

    expect(result?.reply?.text).toContain("- openai (2)");
    expect(result?.reply?.text).toContain("- vllm (2)");
    expect(result?.reply?.text).not.toContain("- anthropic");
  });

  it("honors explicit all browse when listing CLI runtime models", async () => {
    catalog = [
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet (CLI)" },
      {
        provider: "claude-cli",
        id: "claude-opus-4-6",
        name: "Claude Opus (CLI)",
        status: "deprecated",
      },
    ];
    setCredentials(["anthropic", "claude-cli"]);
    const config = configWithDefaults({
      model: { primary: "anthropic/claude-sonnet-4-6" },
      modelPolicy: { allow: ["anthropic/*"] },
    });
    const originalConfig = structuredClone(config);

    const data = await buildPreparedModelsProviderData(config, "main", { view: "all" });

    expect([...(data.byProvider.get("claude-cli") ?? [])].toSorted()).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
    expect(config).toEqual(originalConfig);
  });

  it("keeps the menuonly provider picker browse-only", async () => {
    catalog = [
      ...defaultCatalog.slice(0, 2),
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus (CLI)" },
      ...defaultCatalog.slice(2),
    ];
    setCredentials(["anthropic", "claude-cli", "google", "openai"]);
    const result = await runModels("/models", {}, "menuonly");
    expect(result?.reply?.channelData).toEqual({
      menuonly: {
        providerIds: ["anthropic", "claude-cli", "google", "openai"],
        labels: ["anthropic:2", "claude-cli:1", "google:1", "openai:2"],
      },
    });
  });

  it.each([
    { option: "limit=5", total: 25, pageSize: 5 },
    { option: "size=5", total: 25, pageSize: 5 },
    { option: "limit=50", total: 55, pageSize: 50 },
    { option: "", total: 25, pageSize: 20 },
  ])("follows More without skipping models ($option)", async ({ option, total, pageSize }) => {
    catalog = Array.from({ length: total }, (_, index) => ({
      ...openAIPlatformRoute,
      provider: "openai",
      id: `model-${String(index + 1).padStart(3, "0")}`,
      name: `Model ${index + 1}`,
    }));
    const first = await runModels(`/models openai ${option}`);
    const firstText = first?.reply?.text ?? "";
    const more = /^More: (.+)$/m.exec(firstText)?.[1] ?? "";
    expect(more).not.toBe("");
    const second = await runModels(more);
    const secondText = second?.reply?.text ?? "";
    const rows = [firstText, secondText].flatMap((text) =>
      [...text.matchAll(/^- openai\/(model-\d+)/gm)].map((match) => match[1]),
    );
    expect(rows).toEqual(
      Array.from(
        { length: Math.min(total, pageSize * 2) },
        (_, index) => `model-${String(index + 1).padStart(3, "0")}`,
      ),
    );
    expect(secondText).toContain(
      `showing ${pageSize + 1}-${Math.min(total, pageSize * 2)} of ${total}`,
    );
    if (!option) {
      expect(more).toBe("/models list openai 2");
    }
  });

  it.each([
    { pageSize: 5, total: 25, lastPage: 5 },
    { pageSize: 50, total: 55, lastPage: 2 },
  ])("follows Try with custom size ($pageSize)", async ({ pageSize, total, lastPage }) => {
    catalog = Array.from({ length: total }, (_, index) => ({
      ...openAIPlatformRoute,
      provider: "openai",
      id: `model-${String(index + 1).padStart(3, "0")}`,
      name: `Model ${index + 1}`,
    }));
    const invalid = await runModels(`/models openai 99 limit=${pageSize}`);
    const retry = /^Try: (.+)$/m.exec(invalid?.reply?.text ?? "")?.[1] ?? "";
    expect(retry).not.toBe("");
    const recovered = await runModels(retry);
    expect(recovered?.reply?.text).toContain(
      `showing ${(lastPage - 1) * pageSize + 1}-${total} of ${total} (page ${lastPage}/${lastPage})`,
    );
    expect(recovered?.reply?.text).not.toContain("Page out of range");
  });

  it("keeps all independent of the requested page size", async () => {
    const result = await runModels("/models openai 99 limit=1 all");
    expectOpenAIList(result?.reply?.text);
    expect(result?.reply?.text).not.toContain("More:");
    expect(result?.reply?.text).not.toContain("All:");
  });

  it("lists models without coercing malformed tokens", async () => {
    const result = await runModels("/models openai page=2next limit=1x");
    expectOpenAIList(result?.reply?.text);
  });

  it("does not list bare fallback models under the default provider when catalog ownership is unique", async () => {
    catalog = [
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ];
    const cfg = configWithDefaults({
      model: {
        primary: "openai/gpt-5.4",
        fallbacks: ["deepseek-v4-flash", "deepseek-v4-pro"],
      },
      models: { "openai/gpt-5.4": {} },
    });

    const data = await buildPreparedModelsProviderData(cfg);

    expect([...(data.byProvider.get("openai") ?? [])]).toEqual(["gpt-5.4"]);
    expect([...(data.byProvider.get("deepseek") ?? [])].toSorted()).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("keeps /models list <provider> as an alias", async () => {
    const result = await runModels("/models list anthropic");

    expect(result?.reply?.text).toContain("Models (anthropic) — showing 1-2 of 2 (page 1/1)");
    expect(result?.reply?.text).toContain("- anthropic/claude-opus-4-5");
  });

  it("returns a deprecation message for /models add", async () => {
    const result = await runModels("/models add");
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: MODELS_ADD_DEPRECATED_TEXT },
    });
  });
});
