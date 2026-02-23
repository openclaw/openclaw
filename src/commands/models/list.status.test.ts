import { describe, expect, it, type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type MockAuthProfile = { provider: string; [key: string]: unknown };
  const store = {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "sk-ant-oat01-ACCESS-TOKEN-1234567890",
        refresh: "sk-ant-ort01-REFRESH-TOKEN-1234567890",
        expires: Date.now() + 60_000,
        email: "peter@example.com",
      },
      "anthropic:work": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant-api-0123456789abcdefghijklmnopqrstuvwxyz",
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
    resolveEnvApiKey: vi.fn((provider: string) => {
      if (provider === "openai") {
        return {
          apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz",
          source: "shell env: OPENAI_API_KEY",
        };
      }
      if (provider === "anthropic") {
        return {
          apiKey: "sk-ant-oat01-ACCESS-TOKEN-1234567890",
          source: "env: ANTHROPIC_OAUTH_TOKEN",
        };
      }
      return null;
    }),
    getCustomProviderApiKey: vi.fn().mockReturnValue(undefined),
    getShellEnvAppliedKeys: vi.fn().mockReturnValue(["OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]),
    shouldEnableShellEnvFallback: vi.fn().mockReturnValue(true),
    loadConfig: vi.fn().mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5", fallbacks: [] },
          models: { "anthropic/claude-opus-4-5": { alias: "Opus" } },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    }),
    loadProviderUsageSummary: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentExplicitModelPrimary: mocks.resolveAgentExplicitModelPrimary,
  resolveAgentEffectiveModelPrimary: mocks.resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride: mocks.resolveAgentModelFallbacksOverride,
  listAgentIds: mocks.listAgentIds,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    listProfilesForProvider: mocks.listProfilesForProvider,
    resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
    resolveAuthStorePathForDisplay: mocks.resolveAuthStorePathForDisplay,
  };
});

vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey: mocks.resolveEnvApiKey,
  getCustomProviderApiKey: mocks.getCustomProviderApiKey,
}));

vi.mock("../../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: mocks.getShellEnvAppliedKeys,
  shouldEnableShellEnvFallback: mocks.shouldEnableShellEnvFallback,
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("../../infra/provider-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/provider-usage.js")>();
  return {
    ...actual,
    loadProviderUsageSummary: mocks.loadProviderUsageSummary,
  };
});

import { modelsStatusCommand } from "./list.status-command.js";

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
  it("includes masked auth sources in JSON output", async () => {
    await modelsStatusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String((runtime.log as Mock).mock.calls[0]?.[0]));

    expect(mocks.resolveOpenClawAgentDir).toHaveBeenCalled();
    expect(payload.defaultModel).toBe("anthropic/claude-opus-4-5");
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
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("anthropic")),
    ).toBe(true);
    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("openai-codex")),
    ).toBe(true);
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
