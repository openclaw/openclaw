import { beforeAll, describe, expect, it, type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type MockAuthProfile = { provider: string; [key: string]: unknown };
  const store = {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "sk-ant-oat01-ACCESS-TOKEN-1234567890",
        refresh: "sk-ant-ort01-REFRESH-TOKEN-1234567890", // pragma: allowlist secret
        expires: Date.now() + 60_000,
        email: "peter@example.com",
      },
      "anthropic:work": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant-api-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
      },
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "eyJhbGciOi-ACCESS",
        refresh: "oai-refresh-1234567890",
        expires: Date.now() + 60_000,
      },
    } as Record<string, MockAuthProfile>,
  };

  return {
    store,
    resolveOpenClawAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-agent/workspace"),
    resolveAgentExplicitModelPrimary: vi.fn().mockReturnValue(undefined),
    resolveAgentEffectiveModelPrimary: vi.fn().mockReturnValue(undefined),
    resolveAgentModelFallbacksOverride: vi.fn().mockReturnValue(undefined),
    listAgentIds: vi.fn().mockReturnValue(["main", "jeremiah"]),
    ensureAuthProfileStore: vi.fn().mockReturnValue(store),
    listProfilesForProvider: vi.fn((s: typeof store, provider: string) => {
      return Object.entries(s.profiles)
        .filter(([, cred]) => cred.provider === provider)
        .map(([id]) => id);
    }),
    resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
    resolveAuthStorePathForDisplay: vi
      .fn()
      .mockReturnValue("/tmp/openclaw-agent/auth-profiles.json"),
    resolveProfileUnusableUntilForDisplay: vi.fn().mockReturnValue(undefined),
    resolveEnvApiKey: vi.fn((provider: string) => {
      if (provider === "openai") {
        return {
          apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "shell env: OPENAI_API_KEY",
        };
      }
      if (provider === "anthropic") {
        return {
          apiKey: "sk-ant-oat01-ACCESS-TOKEN-1234567890", // pragma: allowlist secret
          source: "env: ANTHROPIC_OAUTH_TOKEN",
        };
      }
      return null;
    }),
    resolveProviderEnvApiKeyCandidates: vi.fn().mockReturnValue({
      anthropic: ["ANTHROPIC_API_KEY"],
      google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      minimax: ["MINIMAX_API_KEY"],
      "minimax-portal": ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      "openai-codex": ["OPENAI_OAUTH_TOKEN"],
      fal: ["FAL_KEY"],
    }),
    listKnownProviderEnvApiKeyNames: vi
      .fn()
      .mockReturnValue([
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "MINIMAX_API_KEY",
        "MINIMAX_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "OPENAI_OAUTH_TOKEN",
        "FAL_KEY",
      ]),
    hasUsableCustomProviderApiKey: vi.fn().mockReturnValue(false),
    resolveUsableCustomProviderApiKey: vi.fn().mockReturnValue(null),
    getCustomProviderApiKey: vi.fn().mockReturnValue(undefined),
    getShellEnvAppliedKeys: vi.fn().mockReturnValue(["OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]),
    shouldEnableShellEnvFallback: vi.fn().mockReturnValue(true),
    createConfigIO: vi.fn().mockReturnValue({
      configPath: "/tmp/openclaw-dev/openclaw.json",
    }),
    loadConfig: vi.fn().mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          models: { "anthropic/claude-opus-4-6": { alias: "Opus" } },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    }),
    loadProviderUsageSummary: vi.fn().mockResolvedValue(undefined),
  };
});

let modelsStatusCommand: typeof import("./list.status-command.js").modelsStatusCommand;

async function loadFreshModelsStatusCommandModuleForTest() {
  vi.resetModules();
  vi.doMock("../../agents/agent-paths.js", () => ({
    resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
  }));
  vi.doMock("../../agents/agent-scope.js", () => ({
    resolveAgentDir: mocks.resolveAgentDir,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
    resolveAgentExplicitModelPrimary: mocks.resolveAgentExplicitModelPrimary,
    resolveAgentEffectiveModelPrimary: mocks.resolveAgentEffectiveModelPrimary,
    resolveAgentModelFallbacksOverride: mocks.resolveAgentModelFallbacksOverride,
    listAgentIds: mocks.listAgentIds,
  }));
  vi.doMock("../../agents/auth-profiles.js", () => ({
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    listProfilesForProvider: mocks.listProfilesForProvider,
    resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
    resolveAuthStorePathForDisplay: mocks.resolveAuthStorePathForDisplay,
    resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
  }));
  vi.doMock("../../agents/model-auth.js", () => ({
    resolveEnvApiKey: mocks.resolveEnvApiKey,
    hasUsableCustomProviderApiKey: mocks.hasUsableCustomProviderApiKey,
    resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKey,
    getCustomProviderApiKey: mocks.getCustomProviderApiKey,
  }));
  vi.doMock("../../agents/model-auth-env-vars.js", () => ({
    resolveProviderEnvApiKeyCandidates: mocks.resolveProviderEnvApiKeyCandidates,
    listKnownProviderEnvApiKeyNames: mocks.listKnownProviderEnvApiKeyNames,
  }));
  vi.doMock("../../infra/shell-env.js", () => ({
    getShellEnvAppliedKeys: mocks.getShellEnvAppliedKeys,
    shouldEnableShellEnvFallback: mocks.shouldEnableShellEnvFallback,
  }));
  vi.doMock("../../config/config.js", async () => {
    const actual =
      await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
    return {
      ...actual,
      createConfigIO: mocks.createConfigIO,
      loadConfig: mocks.loadConfig,
    };
  });
  vi.doMock("./load-config.js", () => ({
    loadModelsConfig: vi.fn(async () => mocks.loadConfig()),
  }));
  vi.doMock("../../infra/provider-usage.js", () => ({
    formatUsageWindowSummary: vi.fn().mockReturnValue("-"),
    loadProviderUsageSummary: mocks.loadProviderUsageSummary,
    resolveUsageProviderId: vi.fn((providerId: string) => providerId),
  }));
  ({ modelsStatusCommand } = await import("./list.status-command.js"));
}

const defaultResolveEnvApiKeyImpl:
  | ((provider: string) => { apiKey: string; source: string } | null)
  | undefined = mocks.resolveEnvApiKey.getMockImplementation();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

async function withAgentScopeOverrides<T>(
  overrides: {
    primary?: string;
    fallbacks?: string[];
    agentDir?: string;
  },
  run: () => Promise<T>,
) {
  const originalPrimary = mocks.resolveAgentExplicitModelPrimary.getMockImplementation();
  const originalEffectivePrimary = mocks.resolveAgentEffectiveModelPrimary.getMockImplementation();
  const originalFallbacks = mocks.resolveAgentModelFallbacksOverride.getMockImplementation();
  const originalAgentDir = mocks.resolveAgentDir.getMockImplementation();

  mocks.resolveAgentExplicitModelPrimary.mockReturnValue(overrides.primary);
  mocks.resolveAgentEffectiveModelPrimary.mockReturnValue(overrides.primary);
  mocks.resolveAgentModelFallbacksOverride.mockReturnValue(overrides.fallbacks);
  if (overrides.agentDir) {
    mocks.resolveAgentDir.mockReturnValue(overrides.agentDir);
  }

  try {
    return await run();
  } finally {
    if (originalPrimary) {
      mocks.resolveAgentExplicitModelPrimary.mockImplementation(originalPrimary);
    } else {
      mocks.resolveAgentExplicitModelPrimary.mockReturnValue(undefined);
    }
    if (originalEffectivePrimary) {
      mocks.resolveAgentEffectiveModelPrimary.mockImplementation(originalEffectivePrimary);
    } else {
      mocks.resolveAgentEffectiveModelPrimary.mockReturnValue(undefined);
    }
    if (originalFallbacks) {
      mocks.resolveAgentModelFallbacksOverride.mockImplementation(originalFallbacks);
    } else {
      mocks.resolveAgentModelFallbacksOverride.mockReturnValue(undefined);
    }
    if (originalAgentDir) {
      mocks.resolveAgentDir.mockImplementation(originalAgentDir);
    } else {
      mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw-agent");
    }
  }
}

describe("modelsStatusCommand auth overview", () => {
  beforeAll(async () => {
    await loadFreshModelsStatusCommandModuleForTest();
  });

  it("includes masked auth sources in JSON output", async () => {
    await modelsStatusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String((runtime.log as Mock).mock.calls[0]?.[0]));

    expect(mocks.resolveOpenClawAgentDir).toHaveBeenCalled();
    expect(payload.defaultModel).toBe("anthropic/claude-opus-4-6");
    expect(payload.configPath).toBe("/tmp/openclaw-dev/openclaw.json");
    expect(payload.auth.storePath).toBe("/tmp/openclaw-agent/auth-profiles.json");
    expect(payload.auth.shellEnvFallback.enabled).toBe(true);
    expect(payload.auth.shellEnvFallback.appliedKeys).toContain("OPENAI_API_KEY");
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.oauth.warnAfterMs).toBeGreaterThan(0);
    expect(payload.auth.oauth.profiles.length).toBeGreaterThan(0);

    const providers = payload.auth.providers as Array<{
      provider: string;
      profiles: { labels: string[] };
      env?: { value: string; source: string };
    }>;
    const anthropic = providers.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeTruthy();
    expect(anthropic?.profiles.labels.join(" ")).toContain("OAuth");
    expect(anthropic?.profiles.labels.join(" ")).toContain("...");

    const openai = providers.find((p) => p.provider === "openai");
    expect(openai?.env?.source).toContain("OPENAI_API_KEY");
    expect(openai?.env?.value).toContain("...");
    expect(
      (payload.auth.oauth.providers as Array<{ provider: string }>).some(
        (provider) => provider.provider === "openai",
      ),
    ).toBe(false);

    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("anthropic")),
    ).toBe(true);
    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("openai-codex")),
    ).toBe(true);
  });

  it("does not emit raw short api-key values in JSON labels", async () => {
    const localRuntime = createRuntime();
    const shortSecret = "abc123"; // pragma: allowlist secret
    const originalProfiles = { ...mocks.store.profiles };
    mocks.store.profiles = {
      ...mocks.store.profiles,
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: shortSecret,
      },
    };

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
      const providers = payload.auth.providers as Array<{
        provider: string;
        profiles: { labels: string[] };
      }>;
      const openai = providers.find((p) => p.provider === "openai");
      const labels = openai?.profiles.labels ?? [];
      expect(labels.join(" ")).toContain("...");
      expect(labels.join(" ")).not.toContain(shortSecret);
    } finally {
      mocks.store.profiles = originalProfiles;
    }
  });

  it("includes env-backed image-generation providers in effective auth output", async () => {
    const localRuntime = createRuntime();
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();

    mocks.resolveEnvApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") {
        return {
          apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "shell env: OPENAI_API_KEY",
        };
      }
      if (provider === "anthropic") {
        return {
          apiKey: "sk-ant-oat01-ACCESS-TOKEN-1234567890", // pragma: allowlist secret
          source: "env: ANTHROPIC_OAUTH_TOKEN",
        };
      }
      if (provider === "minimax") {
        return {
          apiKey: "sk-minimax-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "env: MINIMAX_API_KEY",
        };
      }
      if (provider === "fal") {
        return {
          apiKey: "fal_test_0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "env: FAL_KEY",
        };
      }
      return null;
    });

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
      const providers = payload.auth.providers as Array<{
        provider: string;
        effective: { kind: string };
      }>;
      expect(providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "minimax",
            effective: expect.objectContaining({ kind: "env" }),
          }),
          expect.objectContaining({
            provider: "fal",
            effective: expect.objectContaining({ kind: "env" }),
          }),
        ]),
      );
    } finally {
      if (originalEnvImpl) {
        mocks.resolveEnvApiKey.mockImplementation(originalEnvImpl);
      } else if (defaultResolveEnvApiKeyImpl) {
        mocks.resolveEnvApiKey.mockImplementation(defaultResolveEnvApiKeyImpl);
      } else {
        mocks.resolveEnvApiKey.mockImplementation(() => null);
      }
    }
  });

  it("uses agent overrides and reports sources", async () => {
    const localRuntime = createRuntime();
    await withAgentScopeOverrides(
      {
        primary: "openai/gpt-4",
        fallbacks: ["openai/gpt-3.5"],
        agentDir: "/tmp/openclaw-agent-custom",
      },
      async () => {
        await modelsStatusCommand({ json: true, agent: "Jeremiah" }, localRuntime as never);
        expect(mocks.resolveAgentDir).toHaveBeenCalledWith(expect.anything(), "jeremiah");
        const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
        expect(payload.agentId).toBe("jeremiah");
        expect(payload.agentDir).toBe("/tmp/openclaw-agent-custom");
        expect(payload.defaultModel).toBe("openai/gpt-4");
        expect(payload.fallbacks).toEqual(["openai/gpt-3.5"]);
        expect(payload.modelConfig).toEqual({
          defaultSource: "agent",
          fallbacksSource: "agent",
        });
      },
    );
  });

  it("does not report cli backends as missing auth", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "codex-cli/gpt-5.4", fallbacks: [] },
          models: { "codex-cli/gpt-5.4": {} },
          cliBackends: { "codex-cli": {} },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    });
    mocks.resolveEnvApiKey.mockImplementation(() => null);

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
      expect(payload.defaultModel).toBe("codex-cli/gpt-5.4");
      expect(payload.auth.missingProvidersInUse).toEqual([]);
    } finally {
      if (originalLoadConfig) {
        mocks.loadConfig.mockImplementation(originalLoadConfig);
      }
      if (originalEnvImpl) {
        mocks.resolveEnvApiKey.mockImplementation(originalEnvImpl);
      } else if (defaultResolveEnvApiKeyImpl) {
        mocks.resolveEnvApiKey.mockImplementation(defaultResolveEnvApiKeyImpl);
      } else {
        mocks.resolveEnvApiKey.mockImplementation(() => null);
      }
    }
  });

  it("dedupes alias and canonical provider ids in auth provider summaries", async () => {
    const localRuntime = createRuntime();
    const originalLoadConfig = mocks.loadConfig.getMockImplementation();
    const originalResolveEnvApiKey = mocks.resolveEnvApiKey.getMockImplementation();

    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "z.ai/glm-4.7", fallbacks: [] },
          models: { "z.ai/glm-4.7": {} },
        },
      },
      models: { providers: { "z.ai": {} } },
      env: { shellEnv: { enabled: true } },
    });
    mocks.resolveEnvApiKey.mockImplementation((provider: string) => {
      if (provider === "zai" || provider === "z.ai" || provider === "z-ai") {
        return {
          apiKey: "sk-zai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "shell env: ZAI_API_KEY",
        };
      }
      return null;
    });

    try {
      await modelsStatusCommand({ json: true }, localRuntime as never);
      const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
      const providers = payload.auth.providers as Array<{ provider: string }>;
      expect(providers.filter((provider) => provider.provider === "zai")).toHaveLength(1);
      expect(providers.some((provider) => provider.provider === "z.ai")).toBe(false);
    } finally {
      if (originalLoadConfig) {
        mocks.loadConfig.mockImplementation(originalLoadConfig);
      }
      if (originalResolveEnvApiKey) {
        mocks.resolveEnvApiKey.mockImplementation(originalResolveEnvApiKey);
      } else if (defaultResolveEnvApiKeyImpl) {
        mocks.resolveEnvApiKey.mockImplementation(defaultResolveEnvApiKeyImpl);
      } else {
        mocks.resolveEnvApiKey.mockImplementation(() => null);
      }
    }
  });

  it("labels defaults when --agent has no overrides", async () => {
    const localRuntime = createRuntime();
    await withAgentScopeOverrides(
      {
        primary: undefined,
        fallbacks: undefined,
      },
      async () => {
        await modelsStatusCommand({ agent: "main" }, localRuntime as never);
        const output = (localRuntime.log as Mock).mock.calls
          .map((call: unknown[]) => String(call[0]))
          .join("\n");
        expect(output).toContain("Default (defaults)");
        expect(output).toContain("Fallbacks (0) (defaults)");
      },
    );
  });

  it("reports defaults source in JSON when --agent has no overrides", async () => {
    const localRuntime = createRuntime();
    await withAgentScopeOverrides(
      {
        primary: undefined,
        fallbacks: undefined,
      },
      async () => {
        await modelsStatusCommand({ json: true, agent: "main" }, localRuntime as never);
        const payload = JSON.parse(String((localRuntime.log as Mock).mock.calls[0]?.[0]));
        expect(payload.modelConfig).toEqual({
          defaultSource: "defaults",
          fallbacksSource: "defaults",
        });
      },
    );
  });

  it("throws when agent id is unknown", async () => {
    const localRuntime = createRuntime();
    await expect(modelsStatusCommand({ agent: "unknown" }, localRuntime as never)).rejects.toThrow(
      'Unknown agent id "unknown".',
    );
  });
  it("exits non-zero when auth is missing", async () => {
    const originalProfiles = { ...mocks.store.profiles };
    mocks.store.profiles = {};
    const localRuntime = createRuntime();
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.resolveEnvApiKey.mockImplementation(() => null);

    try {
      await modelsStatusCommand({ check: true, plain: true }, localRuntime as never);
      expect(localRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
      if (originalEnvImpl) {
        mocks.resolveEnvApiKey.mockImplementation(originalEnvImpl);
      } else if (defaultResolveEnvApiKeyImpl) {
        mocks.resolveEnvApiKey.mockImplementation(defaultResolveEnvApiKeyImpl);
      } else {
        mocks.resolveEnvApiKey.mockImplementation(() => null);
      }
    }
  });
});
