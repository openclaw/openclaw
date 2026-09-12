// Covers provider usage auth profile key normalization.
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type {
  ProviderResolveUsageAuthContext,
  ProviderResolvedUsageAuth,
} from "../plugins/types.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";

const authProfileMocks = vi.hoisted(() => {
  const store: AuthProfileStore = { version: 1, profiles: {} };
  const orders: Record<string, string[]> = {};
  return {
    store,
    orders,
    resolvedProfiles: new Map<string, { apiKey: string; provider: string } | null>(),
    unexpectedStoreRead: () => {
      throw new Error("Usage auth tests must use their prepared store");
    },
  };
});

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: authProfileMocks.unexpectedStoreRead,
  ensureAuthProfileStoreWithoutExternalProfiles: authProfileMocks.unexpectedStoreRead,
  hasAnyAuthProfileStoreSource: authProfileMocks.unexpectedStoreRead,
  dedupeProfileIds: (profileIds: string[]) => [...new Set(profileIds)],
  listProfilesForProvider: (_store: unknown, provider: string) =>
    authProfileMocks.orders[provider] ?? [],
  resolveAuthProfileOrder: ({ provider }: { provider: string }) =>
    authProfileMocks.orders[provider] ?? [],
  resolveApiKeyForProfile: async ({ profileId }: { profileId: string }) =>
    authProfileMocks.resolvedProfiles.get(profileId) ?? null,
}));

const providerRuntimeMocks = vi.hoisted(() => ({
  providerRuntimeMock: {
    resolveProviderUsageAuthWithPlugin:
      vi.fn<
        (params: {
          context: ProviderResolveUsageAuthContext;
        }) => Promise<ProviderResolvedUsageAuth | null>
      >(),
  },
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    ...providerRuntimeMocks.providerRuntimeMock,
  };
});

vi.mock("../plugins/provider-runtime.ts", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.ts")>(
    "../plugins/provider-runtime.ts",
  );
  return {
    ...actual,
    ...providerRuntimeMocks.providerRuntimeMock,
  };
});

vi.mock("../agents/cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

vi.mock("../agents/auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  syncExternalCliCredentials: () => false,
}));

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;
let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-provider-auth-suite-" });

describe("resolveProviderAuths key normalization", () => {
  const EMPTY_PROVIDER_ENV = {
    ZAI_API_KEY: undefined,
    Z_AI_API_KEY: undefined,
    MINIMAX_API_KEY: undefined,
    MINIMAX_CODE_PLAN_KEY: undefined,
    MINIMAX_CODING_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_ADMIN_KEY: undefined,
    ANTHROPIC_ADMIN_KEY: undefined,
    ANTHROPIC_ADMIN_API_KEY: undefined,
    XIAOMI_API_KEY: undefined,
  } satisfies Record<string, string | undefined>;

  beforeAll(async () => {
    await suiteRootTracker.setup();
    ({ resolveProviderAuths } = await import("./provider-usage.auth.js"));
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  beforeEach(() => {
    authProfileMocks.store.profiles = {};
    authProfileMocks.orders = {};
    authProfileMocks.resolvedProfiles.clear();
    providerRuntimeMocks.providerRuntimeMock.resolveProviderUsageAuthWithPlugin
      .mockReset()
      .mockImplementation(async ({ context }) => {
        const token = context.resolveApiKeyFromConfigAndStore();
        return token ? { token } : null;
      });
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.restoreAllMocks();
  });

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    return await fn(await suiteRootTracker.make("case"));
  }

  function agentDirForHome(home: string): string {
    return path.join(home, ".openclaw", "agents", "main", "agent");
  }

  function buildSuiteEnv(
    home: string,
    env: Record<string, string | undefined> = {},
  ): NodeJS.ProcessEnv {
    const suiteEnv: NodeJS.ProcessEnv = {
      ...EMPTY_PROVIDER_ENV,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      ...env,
    };
    const match = home.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      suiteEnv.HOMEDRIVE = match[1];
      suiteEnv.HOMEPATH = match[2] || "\\";
    }
    return suiteEnv;
  }

  function seedProfiles(profiles: AuthProfileStore["profiles"], orders: Record<string, string[]>) {
    authProfileMocks.store.profiles = profiles;
    authProfileMocks.orders = orders;
  }

  function createTestModelDefinition(): ModelDefinitionConfig {
    return {
      id: "test-model",
      name: "Test Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 256,
    };
  }

  async function resolveMinimaxAuthFromConfiguredKey(apiKey: string) {
    return await withSuiteHome(async (home) => {
      const config = {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimaxi.com",
              models: [createTestModelDefinition()],
              apiKey,
            },
          },
        },
      } satisfies OpenClawConfig;

      return await resolveProviderAuths({
        providers: ["minimax"],
        store: authProfileMocks.store,
        agentDir: agentDirForHome(home),
        config,
        env: buildSuiteEnv(home),
      });
    });
  }

  async function expectResolvedAuthsFromSuiteHome(params: {
    providers: Parameters<typeof resolveProviderAuths>[0]["providers"];
    expected: Awaited<ReturnType<typeof resolveProviderAuths>>;
    env?: Record<string, string | undefined>;
    config?: OpenClawConfig;
    setup?: (home: string) => Promise<void>;
  }) {
    await withSuiteHome(async (home) => {
      if (params.setup) {
        await params.setup(home);
      }
      const config = params.config ?? {};
      const auths = await resolveProviderAuths({
        providers: params.providers,
        store: authProfileMocks.store,
        agentDir: agentDirForHome(home),
        config,
        env: buildSuiteEnv(home, params.env),
      });
      expect(auths).toEqual(params.expected);
    });
  }

  it("strips embedded CR/LF from env keys", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi", "xiaomi-token-plan"],
      env: {
        ZAI_API_KEY: "zai-\r\nkey",
        MINIMAX_API_KEY: "minimax-\r\nkey",
        XIAOMI_API_KEY: "xiaomi-\r\nkey",
        XIAOMI_TOKEN_PLAN_API_KEY: "xiaomi-token-\r\nplan",
      },
      expected: [
        { provider: "zai", token: "zai-key" },
        { provider: "minimax", token: "minimax-key" },
        { provider: "xiaomi", token: "xiaomi-key" },
        { provider: "xiaomi-token-plan", token: "xiaomi-token-plan" },
      ],
    });
  }, 300_000);

  it("accepts z-ai env alias and normalizes embedded CR/LF", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      env: {
        Z_AI_API_KEY: "zai-\r\nkey",
      },
      expected: [{ provider: "zai", token: "zai-key" }],
    });
  });

  it("prefers ZAI_API_KEY over the z-ai alias when both are set", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      env: {
        ZAI_API_KEY: "direct-zai-key",
        Z_AI_API_KEY: "alias-zai-key",
      },
      expected: [{ provider: "zai", token: "direct-zai-key" }],
    });
  });

  it("prefers MINIMAX_CODE_PLAN_KEY over MINIMAX_API_KEY", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["minimax"],
      env: {
        MINIMAX_CODE_PLAN_KEY: "code-plan-key",
        MINIMAX_API_KEY: "api-key",
      },
      expected: [{ provider: "minimax", token: "code-plan-key" }],
    });
  });

  it("accepts MINIMAX_CODING_API_KEY as a coding-plan alias", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["minimax"],
      env: {
        MINIMAX_CODING_API_KEY: "coding-api-key",
      },
      expected: [{ provider: "minimax", token: "coding-api-key" }],
    });
  });

  it("strips embedded CR/LF from prepared profile values (token + api_key)", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["minimax", "xiaomi", "xiaomi-token-plan"],
      setup: async () => {
        seedProfiles(
          {
            "minimax:default": { type: "token", provider: "minimax", token: "mini-\r\nmax" },
            "xiaomi:default": { type: "api_key", provider: "xiaomi", key: "xiao-\r\nmi" },
            "xiaomi-token-plan:default": {
              type: "api_key",
              provider: "xiaomi-token-plan",
              key: "token-\r\nplan",
            },
          },
          {
            minimax: ["minimax:default"],
            xiaomi: ["xiaomi:default"],
            "xiaomi-token-plan": ["xiaomi-token-plan:default"],
          },
        );
      },
      expected: [
        { provider: "minimax", token: "mini-max" },
        { provider: "xiaomi", token: "xiao-mi" },
        { provider: "xiaomi-token-plan", token: "token-plan" },
      ],
    });
  });

  it("returns injected auth values unchanged", async () => {
    const auths = await resolveProviderAuths({
      providers: ["anthropic"],
      auth: [{ provider: "anthropic", token: "token-1", accountId: "acc-1" }],
    });
    expect(auths).toEqual([{ provider: "anthropic", token: "token-1", accountId: "acc-1" }]);
  });

  it("uses config api keys when env and profiles are missing", async () => {
    const config = {
      models: {
        providers: {
          zai: {
            baseUrl: "https://api.z.ai",
            models: [createTestModelDefinition()],
            apiKey: "cfg-zai-key", // pragma: allowlist secret
          },
          minimax: {
            baseUrl: "https://api.minimaxi.com",
            models: [createTestModelDefinition()],
            apiKey: "cfg-minimax-key", // pragma: allowlist secret
          },
          xiaomi: {
            baseUrl: "https://api.xiaomi.example",
            models: [createTestModelDefinition()],
            apiKey: "cfg-xiaomi-key", // pragma: allowlist secret
          },
          "xiaomi-token-plan": {
            baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
            models: [createTestModelDefinition()],
            apiKey: "cfg-xiaomi-token-plan-key", // pragma: allowlist secret
          },
        },
      },
    } satisfies OpenClawConfig;
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi", "xiaomi-token-plan"],
      config,
      expected: [
        { provider: "zai", token: "cfg-zai-key" },
        { provider: "minimax", token: "cfg-minimax-key" },
        { provider: "xiaomi", token: "cfg-xiaomi-key" },
        { provider: "xiaomi-token-plan", token: "cfg-xiaomi-token-plan-key" },
      ],
    });
  });

  it("returns no auth when providers have no configured credentials", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi", "xiaomi-token-plan"],
      expected: [],
    });
  });

  it("uses zai api_key auth profiles when env and config are missing", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      setup: async () => {
        seedProfiles(
          {
            "zai:default": { type: "api_key", provider: "zai", key: "profile-zai-key" },
          },
          { zai: ["zai:default"] },
        );
      },
      expected: [{ provider: "zai", token: "profile-zai-key" }],
    });
  });

  it("forwards a resolved OAuth-compatible profile through the plugin callback", async () => {
    authProfileMocks.resolvedProfiles.set("openai:default", {
      apiKey: "chatgpt-token",
      provider: "openai",
    });
    providerRuntimeMocks.providerRuntimeMock.resolveProviderUsageAuthWithPlugin.mockImplementationOnce(
      async ({ context }) => (await context.resolveOAuthToken()) ?? { handled: true },
    );
    await expectResolvedAuthsFromSuiteHome({
      providers: ["openai"],
      setup: async () => {
        seedProfiles(
          {
            "openai:default": {
              type: "token",
              provider: "openai",
              token: "chatgpt-token",
            },
          },
          { openai: ["openai:default"] },
        );
      },
      expected: [{ provider: "openai", token: "chatgpt-token" }],
    });
  });

  it("skips configured profiles when credential resolution returns null", async () => {
    authProfileMocks.resolvedProfiles.set("anthropic:default", null);
    providerRuntimeMocks.providerRuntimeMock.resolveProviderUsageAuthWithPlugin.mockImplementationOnce(
      async ({ context }) => (await context.resolveOAuthToken()) ?? { handled: true },
    );
    await withSuiteHome(async (home) => {
      const config = {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "token" },
          },
        },
      } satisfies OpenClawConfig;
      seedProfiles(
        {
          "anthropic:default": {
            type: "token",
            provider: "zai",
            token: "mismatched-provider-token",
          },
        },
        { anthropic: ["anthropic:default"] },
      );

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        store: authProfileMocks.store,
        agentDir: agentDirForHome(home),
        config,
        env: buildSuiteEnv(home),
      });
      expect(auths).toStrictEqual([]);
    });
  });

  it("skips providers without oauth-compatible profiles", async () => {
    await withSuiteHome(async (home) => {
      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        store: authProfileMocks.store,
        agentDir: agentDirForHome(home),
        config: {},
        env: buildSuiteEnv(home),
      });
      expect(auths).toStrictEqual([]);
    });
  });

  it("skips oauth profiles that resolve without an api key and uses later profiles", async () => {
    authProfileMocks.resolvedProfiles.set("anthropic:empty", null);
    authProfileMocks.resolvedProfiles.set("anthropic:valid", {
      apiKey: "anthropic-token",
      provider: "anthropic",
    });
    providerRuntimeMocks.providerRuntimeMock.resolveProviderUsageAuthWithPlugin.mockImplementationOnce(
      async ({ context }) => (await context.resolveOAuthToken()) ?? { handled: true },
    );
    await withSuiteHome(async (home) => {
      seedProfiles(
        {
          "anthropic:empty": {
            type: "token",
            provider: "anthropic",
            token: "unresolved-token",
          },
          "anthropic:valid": { type: "token", provider: "anthropic", token: "anthropic-token" },
        },
        { anthropic: ["anthropic:empty", "anthropic:valid"] },
      );

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        store: authProfileMocks.store,
        agentDir: agentDirForHome(home),
        config: {},
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "anthropic-token" }]);
    });
  });

  it("skips api_key entries in oauth token resolution order", async () => {
    authProfileMocks.resolvedProfiles.set("anthropic:api", {
      apiKey: "api-key-1",
      provider: "anthropic",
    });
    authProfileMocks.resolvedProfiles.set("anthropic:token", {
      apiKey: "token-1",
      provider: "anthropic",
    });
    providerRuntimeMocks.providerRuntimeMock.resolveProviderUsageAuthWithPlugin.mockImplementationOnce(
      async ({ context }) => (await context.resolveOAuthToken()) ?? { handled: true },
    );
    await withSuiteHome(async (home) => {
      seedProfiles(
        {
          "anthropic:api": { type: "api_key", provider: "anthropic", key: "api-key-1" },
          "anthropic:token": { type: "token", provider: "anthropic", token: "token-1" },
        },
        { anthropic: ["anthropic:api", "anthropic:token"] },
      );

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        store: authProfileMocks.store,
        agentDir: agentDirForHome(home),
        config: {},
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "token-1" }]);
    });
  });

  it("ignores marker-backed config keys for provider usage auth resolution", async () => {
    const auths = await resolveMinimaxAuthFromConfiguredKey(NON_ENV_SECRETREF_MARKER);
    expect(auths).toStrictEqual([]);
  });

  it("keeps all-caps plaintext config keys eligible for provider usage auth resolution", async () => {
    const auths = await resolveMinimaxAuthFromConfiguredKey("ALLCAPS_SAMPLE");
    expect(auths).toEqual([{ provider: "minimax", token: "ALLCAPS_SAMPLE" }]);
  });
});
