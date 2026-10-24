import { createServer } from "node:http";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestWizardPrompter } from "../test-utils/plugin-setup-wizard.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { withLoopbackTestServer } from "./loopback-server.test-support.js";

const mocks = vi.hoisted(() => ({
  authChoice: vi.fn(),
  applyAuth: vi.fn(),
  allowlist: vi.fn<typeof import("../flows/model-picker.js").promptModelAllowlist>(),
  defaultModel: vi.fn<typeof import("../flows/model-picker.js").promptDefaultModel>(),
  providers: vi.fn(() => []),
  providerChoice: vi.fn<() => unknown>(() => null),
  catalog: vi.fn<() => readonly NormalizedModelCatalogRow[]>(() => []),
  preferredProvider: vi.fn<() => Promise<string | undefined>>(async () => undefined),
}));

// mock-isolation: Auth wizard tests use in-memory profiles and must not read or write credentials.
vi.mock("../agents/auth-profiles.js", () => ({
  persistAuthProfileBatch: vi.fn(async () => {}),
  ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
}));

// mock-isolation: Supply the selected auth choice without opening an interactive prompt.
vi.mock("./auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped: mocks.authChoice,
}));

// mock-isolation: Capture auth selection without running provider authentication.
vi.mock("./auth-choice.apply.js", () => ({ applyAuthChoice: mocks.applyAuth }));

// mock-isolation: Provider preference is a fixture input, independent of installed plugins.
vi.mock("../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice: mocks.preferredProvider,
}));

vi.mock("../flows/model-picker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/model-picker.js")>();
  return {
    ...actual,
    promptModelAllowlist: mocks.allowlist,
    promptDefaultModel: mocks.defaultModel,
  };
});

// mock-isolation: Use fixture providers without loading installed provider runtimes.
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.providers,
}));

// mock-isolation: Resolve the fixture wizard selection without discovering real plugins.
vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoiceCore: mocks.providerChoice,
}));

// mock-isolation: Keep model catalogs deterministic and independent of the local installation.
vi.mock("./models/list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList: mocks.catalog,
}));

import { promptAuthConfig } from "./configure.gateway-auth.js";

const { applyAuthChoice: applyProviderAuthChoice } =
  await vi.importActual<typeof import("./auth-choice.apply.js")>("./auth-choice.apply.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preferredProvider.mockResolvedValue(undefined);
  mocks.providerChoice.mockReturnValue(null);
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
  mocks.catalog.mockReturnValue([]);
});

afterEach(() => cliBackendsTesting.resetDepsForTest());

const makeRuntime = (): RuntimeEnv => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

const promptModelAllowlistOptions = () => mocks.allowlist.mock.calls[0]?.[0];
const noopPrompter = {} as WizardPrompter;
const target = { agentId: "ops", agentDir: "/tmp/ops-agent", workspaceDir: "/tmp/ops-workspace" };

function providerModels(id: string) {
  return {
    baseUrl: "https://provider.example/v1",
    api: "openai-completions" as const,
    models: [
      {
        id,
        name: id,
        reasoning: false,
        input: ["text"] as Array<"text" | "image" | "video" | "audio">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
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
    mocks.authChoice.mockResolvedValue("token");
    mocks.applyAuth.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: ["mini"] },
            models: {
              "openai/gpt-5.5": { alias: "GPT" },
              "openai/gpt-5.4-mini": { alias: "mini" },
              "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            },
          },
        },
      },
    });
    mocks.allowlist.mockResolvedValue({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
    });
    mocks.providerChoice.mockReturnValue({
      provider: {
        id: "openai",
        label: "OpenAI",
        auth: [],
        wizard: {
          setup: { modelAllowlist: { allowedKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"] } },
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

  it.each([false, true])("writes selected-agent policy (legacy primary: %s)", async (legacy) => {
    const primary = "openai/gpt-5.5";
    const shared = { primary: "anthropic/claude-sonnet-4-6" };
    const config = legacy
      ? agentConfig({ model: shared }, { primary: "codex/gpt-5.5" })
      : agentConfig({});
    mocks.authChoice.mockResolvedValue(legacy ? "openai-device-code" : "skip");
    if (legacy) {
      mocks.preferredProvider.mockResolvedValue("openai");
      mocks.applyAuth.mockResolvedValue({ config });
    } else {
      mocks.defaultModel.mockResolvedValue({ model: primary });
    }
    mocks.allowlist.mockResolvedValue({
      models: [primary],
      ...(legacy ? { scopeKeys: [primary] } : {}),
    });
    const result = await promptAuthConfig(config, makeRuntime(), noopPrompter, target);
    expect(result.agents?.entries?.OPS?.model).toEqual({ primary });
    expect(result.agents?.entries?.OPS?.modelPolicy?.allow).toEqual([primary]);
    expect(result.agents?.defaults?.model).toEqual(
      legacy ? { primary: "anthropic/claude-sonnet-4-6" } : undefined,
    );
    expect(result.agents?.defaults?.modelPolicy).toBeUndefined();
    expect(promptModelAllowlistOptions()).toMatchObject({
      preferredProvider: "openai",
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
    });
  });

  it("loads the manifest catalog after provider setup", async () => {
    const provider = "github-copilot";
    const existingConfig: OpenClawConfig = {
      models: { providers: { existing: providerModels("old") } },
    };
    mocks.authChoice.mockResolvedValue(provider);
    mocks.preferredProvider.mockResolvedValue(provider);
    mocks.applyAuth.mockResolvedValue({
      config: { ...existingConfig, plugins: { entries: { [provider]: { enabled: true } } } },
    });
    mocks.catalog.mockReturnValueOnce([
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
    mocks.allowlist.mockResolvedValue({ models: undefined });
    await promptAuthConfig(existingConfig, makeRuntime(), noopPrompter);
    expect(mocks.allowlist).toHaveBeenCalledOnce();
    expect(promptModelAllowlistOptions()).toMatchObject({
      preferredProvider: provider,
      loadCatalog: true,
      providerScopedCatalog: false,
    });
  });

  it("returns to auth selection when plugin install onboarding asks for a retry", async () => {
    mocks.authChoice
      .mockResolvedValueOnce("provider-plugin:wecom:default")
      .mockResolvedValueOnce("kilocode-api-key");
    mocks.applyAuth
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
    mocks.allowlist.mockResolvedValue({ models: undefined });
    mocks.preferredProvider.mockResolvedValueOnce("wecom").mockResolvedValueOnce(undefined);

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.authChoice).toHaveBeenCalledTimes(2);
    expect(mocks.applyAuth).toHaveBeenCalledTimes(2);
    expect(mocks.allowlist).toHaveBeenCalledTimes(1);
  });

  it.each(["none", "agent", "shared"] as const)("provider auth: initialize %s", async (owner) => {
    const override = owner !== "none";
    const agentModel = owner === "agent" ? { fallbacks: ["agent/fallback"] } : undefined;
    const defaultModel = owner === "shared" ? { fallbacks: ["shared/fallback"] } : undefined;
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
          models: { providers: { "configure-provider": providerModels("recommended") } },
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
    mocks.authChoice.mockResolvedValue("provider-plugin:configure-provider:api-key");
    mocks.applyAuth.mockImplementationOnce(applyProviderAuthChoice);
    mocks.providerChoice.mockReturnValue({ provider, method });
    mocks.allowlist.mockResolvedValue({
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
      false,
    );
    const result = await promptAuthConfig(config, makeRuntime(), noopPrompter, target);

    const initializesAgent = owner === "agent";
    expect(resolveAgentEffectiveModelPrimary(result, "ops")).toBe(
      override ? recommended : undefined,
    );
    expect(result.agents?.entries?.OPS?.model).toEqual(
      initializesAgent ? { ...agentModel, primary: recommended } : agentModel,
    );
    expect(result.agents?.defaults?.model).toEqual(
      owner === "shared" ? { ...defaultModel, primary: recommended } : defaultModel,
    );
    expect(result.agents?.entries?.OPS?.modelPolicy?.allow).toEqual([
      "shared/available",
      recommended,
    ]);
    expect(result.agents?.defaults?.modelPolicy).toEqual(config.agents?.defaults?.modelPolicy);
    expect(result.agents?.entries?.ops).toBeUndefined();
  });

  it.each([false, true])("custom provider: explicit ownership=%s", async (explicit) => {
    const defaultModel = explicit
      ? { primary: "openai/gpt-5.6-luna" }
      : { fallbacks: ["anthropic/sonnet-4.6"] };
    const agentModel = explicit ? { fallbacks: ["anthropic/sonnet-4.6"] } : undefined;
    const expectedModel = explicit
      ? { fallbacks: ["anthropic/sonnet-4.6"] }
      : { primary: "custom/llama3", fallbacks: ["anthropic/sonnet-4.6"] };
    mocks.authChoice.mockResolvedValue("custom-api-key");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await withLoopbackTestServer(server, async (port) => {
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const prompter = createTestWizardPrompter({
        select: vi.fn().mockResolvedValueOnce("plaintext").mockResolvedValueOnce("openai"),
        text: vi
          .fn()
          .mockResolvedValueOnce(baseUrl)
          .mockResolvedValueOnce("")
          .mockResolvedValueOnce("llama3")
          .mockResolvedValueOnce("custom")
          .mockResolvedValueOnce("Custom"),
        confirm: vi.fn().mockResolvedValue(false),
      });

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
