// Auth choice tests cover auth choice application, provider config, and credential prompts.
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  setupAuthTestEnv,
} from "../../test/helpers/auth-wizard.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import * as providerAuthChoices from "../plugins/provider-auth-choices.js";
import type { ProviderAuthMethod, ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice } from "./auth-choice.apply.js";

type ResolveDeprecatedProviderInstallCatalogEntry =
  typeof import("../plugins/provider-install-catalog.js").resolveDeprecatedProviderInstallCatalogEntry;

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
const resolveDeprecatedProviderInstallCatalogEntry = vi.hoisted(() =>
  vi.fn<ResolveDeprecatedProviderInstallCatalogEntry>(() => undefined),
);

vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveDeprecatedProviderInstallCatalogEntry,
  resolveProviderInstallCatalogEntry: vi.fn(() => undefined),
}));

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders,
  resolvePluginSetupProvider: () => undefined,
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
}));

vi.mock("./auth-choice.apply.api-providers.js", () => {
  const normalizeProviderIdLocal = (value: string) => value.trim().toLowerCase();
  const resolveChoiceByKind = (params: {
    authChoice: string;
    kind: ProviderAuthMethod["kind"];
    tokenProvider?: string;
  }) => {
    const providerId = normalizeProviderIdLocal(params.tokenProvider ?? "");
    if (!providerId) {
      return params.authChoice;
    }
    const provider = resolvePluginProviders().find(
      (entry) => normalizeProviderIdLocal(entry.id) === providerId,
    );
    return (
      provider?.auth.find((method) => method.kind === params.kind)?.wizard?.choiceId ??
      params.authChoice
    );
  };
  return {
    normalizeApiKeyTokenProviderAuthChoice: (params: {
      authChoice: string;
      tokenProvider?: string;
    }) => {
      if (params.authChoice === "token" || params.authChoice === "setup-token") {
        return resolveChoiceByKind({ ...params, kind: "token" });
      }
      if (params.authChoice === "apiKey") {
        return resolveChoiceByKind({ ...params, kind: "api_key" });
      }
      return params.authChoice;
    },
  };
});

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentDir: (configForTest: unknown, agentId: string) =>
    `${process.env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state"}/agents/${agentId}/agent`,
  resolveAgentWorkspaceDir: (configForTest: unknown, agentId: string) =>
    `/tmp/openclaw-workspaces/${agentId}`,
  // Required by src/agents/model-runtime-policy.ts, which is transitively
  // imported through provider-auth-choice -> copilot-runtime-plugin-install ->
  // copilot-routing -> model-runtime-policy.
  resolveSessionAgentIds: () => ({ defaultAgentId: "main", sessionAgentId: "main" }),
  listAgentEntries: () => [],
}));

vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
}));

vi.mock("../infra/browser-open.js", () => ({
  openUrl: vi.fn(async () => {}),
}));

vi.mock("../infra/remote-env.js", () => ({
  isRemoteEnvironment: () => false,
}));

vi.mock("../plugins/provider-oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers: vi.fn(),
}));

vi.mock("../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig: (
    cfg: OpenClawConfig,
    params: {
      profileId: string;
      provider: string;
      mode: "api_key" | "aws-sdk" | "oauth" | "token";
      email?: string;
      displayName?: string;
    },
  ): OpenClawConfig => ({
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles: {
        ...cfg.auth?.profiles,
        [params.profileId]: {
          provider: params.provider,
          mode: params.mode,
          ...(params.email ? { email: params.email } : {}),
          ...(params.displayName ? { displayName: params.displayName } : {}),
        },
      },
    },
  }),
}));

type StoredAuthProfile = {
  key?: string;
  token?: string;
  keyRef?: { source: string; provider: string; id: string };
  access?: string;
  refresh?: string;
  expires?: number;
  provider?: string;
  type?: string;
  email?: string;
  metadata?: Record<string, string>;
};

const testAuthProfileStores = vi.hoisted(
  () => new Map<string, { profiles: Record<string, StoredAuthProfile> }>(),
);

// These tests verify profile payloads, not file locking; keep auth stores in memory.
function resolveTestAuthStoreKey(agentDir?: string): string {
  return agentDir?.trim() || process.env.OPENCLAW_AGENT_DIR || "__main__";
}

function readTestAuthProfileStore(agentDir?: string): {
  profiles: Record<string, StoredAuthProfile>;
} {
  return testAuthProfileStores.get(resolveTestAuthStoreKey(agentDir)) ?? { profiles: {} };
}

function seedTestAuthProfile(params: {
  profileId: string;
  credential: StoredAuthProfile;
  agentDir?: string;
}): void {
  const key = resolveTestAuthStoreKey(params.agentDir);
  const store = testAuthProfileStores.get(key) ?? { profiles: {} };
  store.profiles[params.profileId] = params.credential;
  testAuthProfileStores.set(key, store);
}

vi.mock("../agents/auth-profiles.js", () => ({
  persistAuthProfileBatch: async (params: {
    profiles: readonly {
      profileId: string;
      credential: StoredAuthProfile;
      replaceExisting?: boolean;
    }[];
    agentDir?: string;
  }) => {
    for (const profile of params.profiles) {
      const existing = readTestAuthProfileStore(params.agentDir).profiles[profile.profileId];
      if (profile.replaceExisting === false && existing) {
        continue;
      }
      seedTestAuthProfile({ ...profile, agentDir: params.agentDir });
    }
    return { rollback() {} };
  },
  upsertAuthProfile: (params: {
    profileId: string;
    credential: StoredAuthProfile;
    agentDir?: string;
  }) => {
    seedTestAuthProfile(params);
  },
  upsertAuthProfileWithLock: async (params: {
    profileId: string;
    credential: StoredAuthProfile;
    agentDir?: string;
  }) => {
    seedTestAuthProfile(params);
    return { version: 1, profiles: readTestAuthProfileStore(params.agentDir).profiles };
  },
  upsertAuthProfileWithLockOrThrow: async (params: {
    profileId: string;
    credential: StoredAuthProfile;
    agentDir?: string;
  }) => {
    seedTestAuthProfile(params);
  },
}));

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase();
}

function resolveProviderPluginChoice(params: { providers: ProviderPlugin[]; choice: string }) {
  const choice = params.choice.trim();
  if (!choice) {
    return null;
  }
  if (choice.startsWith("provider-plugin:")) {
    const payload = choice.slice("provider-plugin:".length);
    const separator = payload.indexOf(":");
    const providerId = separator >= 0 ? payload.slice(0, separator) : payload;
    const methodId = separator >= 0 ? payload.slice(separator + 1) : undefined;
    const provider = params.providers.find(
      (entry) => normalizeProviderId(entry.id) === normalizeProviderId(providerId),
    );
    const method = methodId
      ? provider?.auth.find((entry) => entry.id === methodId)
      : provider?.auth[0];
    return provider && method ? { provider, method } : null;
  }
  for (const provider of params.providers) {
    for (const method of provider.auth) {
      if (method.wizard?.choiceId === choice) {
        return { provider, method, wizard: method.wizard };
      }
    }
    if (normalizeProviderId(provider.id) === normalizeProviderId(choice) && provider.auth[0]) {
      return { provider, method: provider.auth[0] };
    }
  }
  return null;
}

function createOpenAiProvider(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI API key",
    auth: [
      {
        id: "api-key",
        label: "OpenAI API key",
        kind: "api_key",
        wizard: { choiceId: "openai-api-key" },
        run: async (ctx) => {
          const env = ctx.env ?? process.env;
          const envKey = env.OPENAI_API_KEY?.trim();
          const useEnv =
            envKey &&
            (await ctx.prompter.confirm({
              message: "Use OPENAI_API_KEY from environment?",
            }));
          const key = useEnv
            ? envKey
            : await ctx.prompter.text({ message: "Enter OpenAI API key" });
          return {
            profiles: [
              {
                profileId: "openai:api-key",
                credential: { type: "api_key", provider: "openai", key },
              },
            ],
            defaultModel: "openai/gpt-5.5",
          };
        },
      },
    ],
  };
}

function createFixedChoiceProvider(params: {
  providerId: string;
  label: string;
  choiceId: string;
  method: ProviderAuthMethod;
}): ProviderPlugin {
  return {
    id: params.providerId,
    label: params.label,
    auth: [
      {
        ...params.method,
        wizard: {
          choiceId: params.choiceId,
          choiceLabel: params.label,
          groupId: params.providerId,
          groupLabel: params.label,
        },
      },
    ],
  };
}

describe("applyAuthChoice", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "GEMINI_API_KEY",
    "OPENCODE_API_KEY",
    "SYNTHETIC_API_KEY",
  ]);
  let authTestRoot: string | null = null;
  let authTestCleanup: (() => Promise<void>) | null = null;
  let authStateCounter = 0;
  async function setupTempState() {
    if (!authTestRoot) {
      throw new Error("auth test root not initialized");
    }
    testAuthProfileStores.clear();
    const stateDir = path.join(authTestRoot, `state-${++authStateCounter}`);
    const agentDir = path.join(stateDir, "agent");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
  }
  function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
    return createWizardPrompter(overrides, { defaultSelect: "" });
  }
  function createSelectFirstOption(): WizardPrompter["select"] {
    return vi.fn(async (params) => params.options[0]?.value as never);
  }
  function createNoopMultiselect(): WizardPrompter["multiselect"] {
    return vi.fn(async () => []);
  }
  function createApiKeyPromptHarness(
    overrides: Partial<Pick<WizardPrompter, "select" | "multiselect" | "text" | "confirm">> = {},
  ): {
    select: WizardPrompter["select"];
    multiselect: WizardPrompter["multiselect"];
    prompter: WizardPrompter;
    runtime: ReturnType<typeof createExitThrowingRuntime>;
  } {
    const select = overrides.select ?? createSelectFirstOption();
    const multiselect = overrides.multiselect ?? createNoopMultiselect();
    return {
      select,
      multiselect,
      prompter: createPrompter({ ...overrides, select, multiselect }),
      runtime: createExitThrowingRuntime(),
    };
  }
  async function readAuthProfiles() {
    return readTestAuthProfileStore(resolveAgentDir({} as OpenClawConfig, "main"));
  }
  async function readAuthProfile(profileId: string) {
    return (await readAuthProfiles()).profiles?.[profileId];
  }
  function expectAuthProfileConfig(
    result: { config: OpenClawConfig },
    profileId: string,
    expected: { provider: string; mode: string },
  ) {
    const profile = result.config.auth?.profiles?.[profileId];
    expect(profile?.provider).toBe(expected.provider);
    expect(profile?.mode).toBe(expected.mode);
  }
  function promptMessages(mock: { mock: { calls: unknown[][] } }): string[] {
    return mock.mock.calls.map((call) => {
      const message = (call[0] as { message?: unknown }).message;
      return typeof message === "string" ? message : "";
    });
  }
  function expectPromptMessageContaining(mock: { mock: { calls: unknown[][] } }, expected: string) {
    expect(promptMessages(mock).join("\n")).toContain(expected);
  }
  function firstCallArg(mock: { mock: { calls: unknown[][] } }): unknown {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error("Expected first mock call");
    }
    return call[0];
  }

  let defaultProviderPlugins: ProviderPlugin[] = [];

  beforeAll(async () => {
    const authTestEnv = await setupAuthTestEnv("openclaw-auth-");
    authTestRoot = authTestEnv.stateDir;
    authTestCleanup = authTestEnv.cleanup;
    defaultProviderPlugins = [createOpenAiProvider()];
    resolvePluginProviders.mockReturnValue(defaultProviderPlugins);
  });

  afterAll(async () => {
    await authTestCleanup?.();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    resolvePluginProviders.mockReset();
    resolvePluginProviders.mockReturnValue(defaultProviderPlugins);
    runProviderModelSelectedHook.mockClear();
    resolveDeprecatedProviderInstallCatalogEntry.mockReset();
    resolveDeprecatedProviderInstallCatalogEntry.mockReturnValue(undefined);
    testAuthProfileStores.clear();
    await lifecycle.cleanup();
  });

  it("applies Anthropic setup-token auth when the provider exposes the setup flow", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      createFixedChoiceProvider({
        providerId: "anthropic",
        label: "Anthropic",
        choiceId: "setup-token",
        method: {
          id: "setup-token",
          label: "Anthropic setup-token",
          kind: "token",
          run: vi.fn(async (): Promise<ProviderAuthResult> => ({
            profiles: [
              {
                profileId: "anthropic:default",
                credential: {
                  type: "token",
                  provider: "anthropic",
                  token: `sk-ant-oat01-${"a".repeat(80)}`,
                },
              },
            ],
            defaultModel: "anthropic/claude-sonnet-4-6",
          })),
        },
      }),
    ]);

    const result = await applyAuthChoice({
      authChoice: "token",
      config: {} as OpenClawConfig,
      prompter: createPrompter({}),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
      opts: {
        tokenProvider: "anthropic",
        token: `sk-ant-oat01-${"a".repeat(80)}`,
      },
    });

    expectAuthProfileConfig(result, "anthropic:default", {
      provider: "anthropic",
      mode: "token",
    });
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect((await readAuthProfile("anthropic:default"))?.token).toBe(
      `sk-ant-oat01-${"a".repeat(80)}`,
    );
  });

  it("escapes removed provider auth choice guidance for terminal output", async () => {
    const spy = vi
      .spyOn(providerAuthChoices, "resolveManifestDeprecatedProviderAuthChoice")
      .mockReturnValueOnce({
        choiceId: "modern\nchoice",
      } as never);
    try {
      await expect(
        applyAuthChoice({
          authChoice: "legacy\u001b[31mchoice",
          config: {},
          prompter: createPrompter({}),
          runtime: createExitThrowingRuntime(),
          setDefaultModel: true,
        }),
      ).rejects.toThrow(
        'Auth choice "legacy\\u001b[31mchoice" is no longer supported. Use "modern\\nchoice" instead, or run openclaw onboard to choose interactively.',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("guides external provider auth-choice replacements before the plugin is installed", async () => {
    const deprecatedChoiceSpy = vi
      .spyOn(providerAuthChoices, "resolveManifestDeprecatedProviderAuthChoice")
      .mockReturnValueOnce(undefined);
    resolveDeprecatedProviderInstallCatalogEntry.mockReturnValueOnce({
      choiceId: "qwen-api-key",
    } as never);
    try {
      await expect(
        applyAuthChoice({
          authChoice: "modelstudio-api-key",
          config: {},
          prompter: createPrompter({}),
          runtime: createExitThrowingRuntime(),
          setDefaultModel: true,
        }),
      ).rejects.toThrow(
        'Auth choice "modelstudio-api-key" is no longer supported. Use "qwen-api-key" instead, or run openclaw onboard to choose interactively.',
      );
    } finally {
      deprecatedChoiceSpy.mockRestore();
    }
  });

  it("uses explicit env for plugin auth resolution instead of host env", async () => {
    await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-host"; // pragma: allowlist secret
    const env = { OPENAI_API_KEY: "sk-openai-explicit" } as NodeJS.ProcessEnv; // pragma: allowlist secret
    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "openai-api-key",
      config: {},
      env,
      prompter,
      runtime,
      setDefaultModel: false,
    });

    const providerResolveInput = firstCallArg(resolvePluginProviders) as {
      env?: NodeJS.ProcessEnv;
      mode?: string;
    };
    expect(providerResolveInput.env).toBe(env);
    expect(providerResolveInput.mode).toBe("setup");
    expectPromptMessageContaining(confirm, "OPENAI_API_KEY");
    expect(text).not.toHaveBeenCalled();
    expectAuthProfileConfig(result, "openai:api-key", {
      provider: "openai",
      mode: "api_key",
    });
    expect((await readAuthProfile("openai:api-key"))?.key).toBe("sk-openai-explicit");
  });
});
