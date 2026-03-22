import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyCredential, AuthProfileStore } from "../../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { GIGACHAT_BASE_URL } from "../../onboard-auth.models.js";
import { applySimpleNonInteractiveApiKeyChoice } from "./auth-choice.api-key-providers.js";

const loadAuthProfileStoreForSecretsRuntime = vi.hoisted(() =>
  vi.fn<() => AuthProfileStore>(() => ({ version: 1, profiles: {} })),
);
const resolveAuthProfileOrder = vi.hoisted(() =>
  vi.fn<
    (params: {
      cfg?: OpenClawConfig;
      store: AuthProfileStore;
      provider: string;
      preferredProfile?: string;
    }) => string[]
  >(() => []),
);
vi.mock("../../../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreForSecretsRuntime,
  resolveAuthProfileOrder,
}));

const applyAuthProfileConfig = vi.hoisted(() => vi.fn((cfg: OpenClawConfig) => cfg));
vi.mock("../../../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig,
}));

const setGigachatApiKey = vi.hoisted(() => vi.fn(async () => {}));
const setLitellmApiKey = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../plugins/provider-auth-storage.js", () => ({
  setGigachatApiKey,
  setLitellmApiKey,
}));

const applyGigachatConfig = vi.hoisted(() => vi.fn((cfg: OpenClawConfig) => cfg));
vi.mock("../../onboard-auth.config-core.js", () => ({
  applyGigachatConfig,
}));

const applyLitellmConfig = vi.hoisted(() => vi.fn((cfg: OpenClawConfig) => cfg));
vi.mock("../../onboard-auth.config-litellm.js", () => ({
  applyLitellmConfig,
}));

describe("applySimpleNonInteractiveApiKeyChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadAuthProfileStoreForSecretsRuntime.mockReturnValue({ version: 1, profiles: {} });
    resolveAuthProfileOrder.mockImplementation(({ cfg, store, provider }) => {
      const configuredOrder =
        cfg &&
        typeof cfg === "object" &&
        "auth" in cfg &&
        cfg.auth &&
        typeof cfg.auth === "object" &&
        "order" in cfg.auth
          ? (cfg.auth.order?.[provider] ?? [])
          : [];
      if (configuredOrder.length > 0) {
        return [...configuredOrder];
      }
      return (Object.entries(store.profiles) as Array<[string, { provider: string }]>)
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId);
    });
    applyAuthProfileConfig.mockImplementation((cfg: OpenClawConfig) => cfg);
    applyGigachatConfig.mockImplementation((cfg: OpenClawConfig) => cfg);
    applyLitellmConfig.mockImplementation((cfg: OpenClawConfig) => cfg);
  });

  it("allows stored OAuth profile fallback for GigaChat personal OAuth onboarding", async () => {
    const agentDir = "/tmp/openclaw-agents/work/agent";
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const resolveApiKey = vi.fn(async () => ({
      key: "gigachat-oauth-credentials",
      source: "profile" as const,
      profileId: "gigachat:default",
      metadata: {
        authMode: "oauth",
        scope: "GIGACHAT_API_PERS",
      },
    }));
    const maybeSetResolvedApiKey = vi.fn(async (resolved, setter) => {
      if (resolved.source === "profile") {
        return true;
      }
      await setter(resolved.key);
      return true;
    });

    await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-api-key",
      nextConfig,
      baseConfig: nextConfig,
      opts: {} as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as never,
      agentDir,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gigachat",
        flagName: "--gigachat-api-key",
        envVar: "GIGACHAT_CREDENTIALS",
        agentDir,
        allowProfile: true,
      }),
    );
    expect(maybeSetResolvedApiKey).toHaveBeenCalledOnce();
    expect(setGigachatApiKey).not.toHaveBeenCalled();
  });

  it("rejects business-scoped stored profiles for GigaChat personal OAuth onboarding", async () => {
    const agentDir = "/tmp/openclaw-agents/work/agent";
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };
    const resolveApiKey = vi.fn(async () => ({
      key: "gigachat-business-credentials",
      source: "profile" as const,
      profileId: "gigachat:business",
      metadata: {
        authMode: "oauth",
        scope: "GIGACHAT_API_B2B",
      },
    }));
    const maybeSetResolvedApiKey = vi.fn();

    const result = await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-api-key",
      nextConfig,
      baseConfig: nextConfig,
      opts: {} as never,
      runtime,
      agentDir,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(result).toBeNull();
    expect(maybeSetResolvedApiKey).not.toHaveBeenCalled();
    expect(setGigachatApiKey).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("scoped for business billing"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("accepts the generic --token input for GigaChat non-interactive OAuth", async () => {
    const agentDir = "/tmp/openclaw-agents/work/agent";
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const resolveApiKey = vi.fn(async () => ({
      key: "gigachat-token-credentials",
      source: "flag" as const,
    }));
    const maybeSetResolvedApiKey = vi.fn(async (resolved, setter) => {
      await setter(resolved.key);
      return true;
    });

    await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-oauth",
      nextConfig,
      baseConfig: nextConfig,
      opts: { token: "gigachat-token-credentials" } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as never,
      agentDir,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gigachat",
        flagValue: "gigachat-token-credentials",
        flagName: "--gigachat-api-key",
        envVar: "GIGACHAT_CREDENTIALS",
        agentDir,
        allowProfile: true,
      }),
    );
    expect(setGigachatApiKey).toHaveBeenCalledWith(
      "gigachat-token-credentials",
      agentDir,
      undefined,
      {
        authMode: "oauth",
        scope: "GIGACHAT_API_PERS",
      },
    );
  });

  it("rejects Basic-shaped GIGACHAT_CREDENTIALS in the OAuth onboarding path", async () => {
    const agentDir = "/tmp/openclaw-agents/work/agent";
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };
    const resolveApiKey = vi.fn(async () => ({
      key: "basic-user:basic-pass",
      source: "env" as const,
    }));
    const maybeSetResolvedApiKey = vi.fn();

    const result = await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-api-key",
      nextConfig,
      baseConfig: nextConfig,
      opts: {} as never,
      runtime,
      agentDir,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(result).toBeNull();
    expect(maybeSetResolvedApiKey).not.toHaveBeenCalled();
    expect(setGigachatApiKey).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Basic user:password credentials"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects Basic-shaped stored profiles in the OAuth onboarding path", async () => {
    const agentDir = "/tmp/openclaw-agents/work/agent";
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };
    const resolveApiKey = vi.fn(async () => ({
      key: "basic-user:basic-pass",
      source: "profile" as const,
    }));
    const maybeSetResolvedApiKey = vi.fn();

    const result = await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-api-key",
      nextConfig,
      baseConfig: nextConfig,
      opts: {} as never,
      runtime,
      agentDir,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(result).toBeNull();
    expect(maybeSetResolvedApiKey).not.toHaveBeenCalled();
    expect(setGigachatApiKey).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Basic user:password credentials"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("accepts OAuth credentials keys that contain colons", async () => {
    const agentDir = "/tmp/openclaw-agents/work/agent";
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };
    const resolveApiKey = vi.fn(async () => ({
      key: "oauth:credential:with:colon",
      source: "env" as const,
    }));
    const maybeSetResolvedApiKey = vi.fn(async (resolved, setter) => {
      await setter(resolved.key);
      return true;
    });

    const result = await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-api-key",
      nextConfig,
      baseConfig: nextConfig,
      opts: {} as never,
      runtime,
      agentDir,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(result).toBe(nextConfig);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(setGigachatApiKey).toHaveBeenCalledWith(
      "oauth:credential:with:colon",
      agentDir,
      undefined,
      {
        authMode: "oauth",
        scope: "GIGACHAT_API_PERS",
      },
    );
  });

  it("resets the GigaChat provider base URL when replacing a Basic profile with OAuth", async () => {
    const agentDir = "/tmp/openclaw-agents/work/agent";
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    const basicProfile: ApiKeyCredential = {
      type: "api_key",
      provider: "gigachat",
      key: "basic-user:basic-pass",
      metadata: {
        authMode: "basic",
      },
    };
    loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "gigachat:default": basicProfile,
      },
    });
    const resolveApiKey = vi.fn(async () => ({
      key: "gigachat-oauth-credentials",
      source: "flag" as const,
    }));
    const maybeSetResolvedApiKey = vi.fn(async (resolved, setter) => {
      await setter(resolved.key);
      return true;
    });

    await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-oauth",
      nextConfig,
      baseConfig: {
        models: {
          providers: {
            gigachat: {
              baseUrl: "https://preview-basic.gigachat.example/api/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      opts: { token: "gigachat-oauth-credentials" } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as never,
      agentDir,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(loadAuthProfileStoreForSecretsRuntime).toHaveBeenCalledWith(agentDir);
    expect(applyGigachatConfig).toHaveBeenCalledWith(expect.any(Object), {
      baseUrl: GIGACHAT_BASE_URL,
    });
  });

  it("resets the GigaChat provider base URL when the active ordered profile is Basic", async () => {
    const agentDir = "/tmp/openclaw-agents/work/agent";
    const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
    loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "gigachat:work": {
          type: "api_key",
          provider: "gigachat",
          key: "basic-user:basic-pass",
          metadata: {
            authMode: "basic",
          },
        },
        "gigachat:default": {
          type: "api_key",
          provider: "gigachat",
          key: "gigachat-oauth-credentials",
          metadata: {
            authMode: "oauth",
            scope: "GIGACHAT_API_PERS",
          },
        },
      },
    });
    const resolveApiKey = vi.fn(async () => ({
      key: "gigachat-oauth-credentials",
      source: "flag" as const,
    }));
    const maybeSetResolvedApiKey = vi.fn(async (resolved, setter) => {
      await setter(resolved.key);
      return true;
    });

    await applySimpleNonInteractiveApiKeyChoice({
      authChoice: "gigachat-oauth",
      nextConfig,
      baseConfig: {
        auth: {
          profiles: {
            "gigachat:work": { provider: "gigachat", mode: "api_key" },
            "gigachat:default": { provider: "gigachat", mode: "api_key" },
          },
          order: { gigachat: ["gigachat:work", "gigachat:default"] },
        },
        models: {
          providers: {
            gigachat: {
              baseUrl: "https://preview-basic.gigachat.example/api/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      opts: { token: "gigachat-oauth-credentials" } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as never,
      agentDir,
      apiKeyStorageOptions: undefined,
      resolveApiKey,
      maybeSetResolvedApiKey,
    });

    expect(applyGigachatConfig).toHaveBeenCalledWith(expect.any(Object), {
      baseUrl: GIGACHAT_BASE_URL,
    });
  });
});
