// Covers provider usage auth profile key normalization.
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  ProviderResolveUsageAuthContext,
  ProviderResolvedUsageAuth,
} from "../plugins/types.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
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

  async function resolve(
    providers: string[],
    config: OpenClawConfig = {},
    env: NodeJS.ProcessEnv = {},
  ) {
    return withSuiteHome(async (home) =>
      resolveProviderAuths({
        providers,
        config,
        env: buildSuiteEnv(home, env),
        store: authProfileMocks.store,
        agentDir: agentDirForHome(home),
      }),
    );
  }

  it("strips embedded CR/LF from env credentials", async () => {
    expect(
      await resolve(
        ["zai", "minimax"],
        {},
        {
          ZAI_API_KEY: "zai-\r\nkey",
          MINIMAX_API_KEY: "mini-\r\nmax",
        },
      ),
    ).toEqual([
      { provider: "zai", token: "zai-key" },
      { provider: "minimax", token: "mini-max" },
    ]);
  });

  it("normalizes both token and API-key profile candidates", async () => {
    authProfileMocks.store.profiles = {
      "minimax:default": { type: "token", provider: "minimax", token: "mini-\r\nmax" },
      "xiaomi:default": { type: "api_key", provider: "xiaomi", key: "xiao-\r\nmi" },
    };
    authProfileMocks.orders = { minimax: ["minimax:default"], xiaomi: ["xiaomi:default"] };
    expect(await resolve(["minimax", "xiaomi"])).toEqual([
      { provider: "minimax", token: "mini-max" },
      { provider: "xiaomi", token: "xiao-mi" },
    ]);
  });

  it.each([
    ["plaintext", "ALLCAPS_SAMPLE", [{ provider: "minimax", token: "ALLCAPS_SAMPLE" }]],
    ["unresolved SecretRef", NON_ENV_SECRETREF_MARKER, []],
  ] as const)("resolves configured %s credentials", async (_name, apiKey, expected) => {
    expect(
      await resolve(["minimax"], {
        models: {
          providers: {
            minimax: { baseUrl: "https://api.minimaxi.com", models: [], apiKey },
          },
        },
      }),
    ).toEqual(expected);
  });

  it("returns no auth without a credential source", async () => {
    expect(await resolve(["zai", "anthropic"])).toEqual([]);
  });

  it("resolves the first usable OAuth-compatible profile, skipping API keys and unresolved tokens", async () => {
    authProfileMocks.store.profiles = {
      "anthropic:api": { type: "api_key", provider: "anthropic", key: "api-key" },
      "anthropic:empty": { type: "token", provider: "anthropic", token: "unresolved" },
      "anthropic:valid": { type: "token", provider: "anthropic", token: "token-1" },
    };
    authProfileMocks.orders = {
      anthropic: ["anthropic:api", "anthropic:empty", "anthropic:valid"],
    };
    authProfileMocks.resolvedProfiles.set("anthropic:api", {
      apiKey: "api-key",
      provider: "anthropic",
    });
    authProfileMocks.resolvedProfiles.set("anthropic:valid", {
      apiKey: "token-1",
      provider: "anthropic",
    });
    providerRuntimeMocks.providerRuntimeMock.resolveProviderUsageAuthWithPlugin.mockImplementationOnce(
      async ({ context }) => (await context.resolveOAuthToken()) ?? { handled: true },
    );
    expect(await resolve(["anthropic"])).toEqual([{ provider: "anthropic", token: "token-1" }]);
  });
});
