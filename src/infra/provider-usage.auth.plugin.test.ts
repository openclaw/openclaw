import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { resolveProviderAuths } from "./provider-usage.auth.js";

const {
  resolvePlugin,
  hasSource,
  emptyStore: createEmptyStore,
  loadStore,
  loadLocalStore,
  order,
  resolveKey,
} = vi.hoisted(() => {
  const emptyStore = (): AuthProfileStore => ({ version: 1, profiles: {} });
  return {
    resolvePlugin:
      vi.fn<typeof import("../plugins/provider-runtime.js").resolveProviderUsageAuthWithPlugin>(),
    hasSource: vi.fn(() => false),
    emptyStore,
    loadStore: vi.fn(emptyStore),
    loadLocalStore: vi.fn(emptyStore),
    order: vi.fn((_params: { provider: string }): string[] => []),
    resolveKey: vi.fn(
      async (_params: {
        profileId: string;
      }): Promise<{ apiKey: string; provider: string } | null> => null,
    ),
  };
});

vi.mock("../agents/auth-profiles.js", () => ({
  dedupeProfileIds: (ids: string[]) => [...new Set(ids)],
  ensureAuthProfileStore: () => loadStore(),
  ensureAuthProfileStoreWithoutExternalProfiles: () => loadLocalStore(),
  hasAnyAuthProfileStoreSource: () => hasSource(),
  listProfilesForProvider: () => [],
  resolveApiKeyForProfile: (params: { profileId: string }) => resolveKey(params),
  resolveAuthProfileOrder: (params: { provider: string }) => order(params),
}));
vi.mock("../plugins/provider-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  )),
  resolveProviderUsageAuthWithPlugin: resolvePlugin,
}));
vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({
    plugins: [
      {
        id: "minimax",
        origin: "bundled",
        providers: ["minimax", "minimax-portal"],
      },
      {
        id: "openai",
        origin: "bundled",
        providers: ["openai"],
        providerUsageAuthEnvVars: {
          openai: ["OPENAI_ADMIN_KEY"],
        },
      },
    ],
  }),
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  listKnownProviderAuthEnvVarNamesCore: () => [
    "ANTHROPIC_API_KEY",
    "MINIMAX_CODE_PLAN_KEY",
    "OPENAI_API_KEY",
  ],
  resolveProviderAuthEnvVarCandidatesCore: () => ({
    anthropic: ["ANTHROPIC_API_KEY"],
    minimax: ["MINIMAX_CODE_PLAN_KEY"],
    openai: ["OPENAI_API_KEY"],
    zai: ["ZAI_API_KEY"],
  }),
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {
      anthropic: ["ANTHROPIC_API_KEY"],
      minimax: ["MINIMAX_CODE_PLAN_KEY"],
      openai: ["OPENAI_API_KEY"],
      zai: ["ZAI_API_KEY"],
    },
    authEvidenceMap: {},
  }),
}));

const resolve = (providers: string[], env: NodeJS.ProcessEnv = {}) =>
  resolveProviderAuths({ providers, env, config: {}, agentDir: "/tmp/openclaw-agent" });
function seed(profiles: AuthProfileStore["profiles"], orders: Record<string, string[]>) {
  const store = { version: 1, profiles };
  hasSource.mockReturnValue(true);
  loadStore.mockReturnValue(store);
  loadLocalStore.mockReturnValue(store);
  order.mockImplementation(({ provider }) => orders[provider] ?? []);
  return store;
}

describe("provider usage auth boundary", () => {
  beforeEach(() => {
    hasSource.mockReset().mockReturnValue(false);
    loadStore.mockReset().mockImplementation(createEmptyStore);
    loadLocalStore.mockReset().mockImplementation(createEmptyStore);
    order.mockReset().mockReturnValue([]);
    resolveKey.mockReset().mockResolvedValue(null);
    resolvePlugin.mockReset().mockResolvedValue(undefined);
  });

  it("normalizes direct plugin candidates ahead of provider environment credentials", async () => {
    resolvePlugin.mockImplementationOnce(async ({ context }) => {
      const token = context.resolveApiKeyFromConfigAndStore({
        envDirect: [undefined, "first-\r\nkey", "second-key"],
      });
      return token ? { token } : undefined;
    });
    expect(await resolve(["zai"], { ZAI_API_KEY: "fallback-key" })).toEqual([
      { provider: "zai", token: "first-key" },
    ]);
  });

  it("preserves plugin failures for direct callers", async () => {
    const error = new Error("plugin auth failed");
    resolvePlugin.mockRejectedValueOnce(error);
    await expect(resolve(["anthropic"], { ANTHROPIC_API_KEY: "fixture-key" })).rejects.toBe(error);
  });

  it("resolves SecretRefs before credential classification", async () => {
    const store = seed(
      {
        "anthropic:admin": {
          type: "api_key",
          provider: "anthropic",
          keyRef: { source: "env", provider: "default", id: "ANTHROPIC_ADMIN_KEY" },
        },
      },
      { anthropic: ["anthropic:admin"] },
    );
    resolveKey.mockResolvedValue({ apiKey: "sk-ant-admin-secretref", provider: "anthropic" });
    resolvePlugin.mockImplementationOnce(async ({ context }) => {
      const candidates = await context.resolveApiKeyCandidatesFromConfigAndStore?.({
        providerIds: ["anthropic"],
      });
      expect(candidates).toEqual(["sk-ant-admin-secretref"]);
      return candidates?.[0] ? { token: candidates[0] } : undefined;
    });
    expect(await resolve(["anthropic"])).toEqual([
      { provider: "anthropic", token: "sk-ant-admin-secretref" },
    ]);
    expect(resolveKey).toHaveBeenCalledExactlyOnceWith({
      cfg: {},
      store,
      profileId: "anthropic:admin",
      agentDir: "/tmp/openclaw-agent",
    });
  });

  it("excludes native profiles while preserving the selected OAuth flow", async () => {
    seed(
      {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "anthropic",
          access: "native-access",
          refresh: "native-refresh",
          expires: 1_900_000_000_000,
        },
        "anthropic:managed": {
          type: "oauth",
          provider: "anthropic",
          access: "managed-access",
          refresh: "managed-refresh",
          expires: 1_900_000_000_000,
          authFlow: "external-flow",
        },
      },
      { anthropic: ["anthropic:claude-cli", "anthropic:managed"] },
    );
    resolveKey.mockImplementation(async ({ profileId }) => ({
      apiKey: profileId === "anthropic:managed" ? "managed-access" : "native-access",
      provider: "anthropic",
    }));
    resolvePlugin.mockImplementationOnce(
      async ({ context }) =>
        (await context.resolveOAuthToken({ excludeProfileIds: ["anthropic:claude-cli"] })) ??
        undefined,
    );
    expect(await resolve(["anthropic"])).toEqual([
      { provider: "anthropic", token: "managed-access", authFlow: "external-flow" },
    ]);
    expect(resolveKey).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ profileId: "anthropic:managed" }),
    );
  });

  it("finds credentials through owned aliases without importing unrelated providers", async () => {
    seed(
      {
        "minimax-portal:default": {
          type: "oauth",
          provider: "minimax-portal",
          access: "portal-token",
          refresh: "refresh",
          expires: 1_900_000_000_000,
        },
      },
      { "minimax-portal": ["minimax-portal:default"] },
    );
    resolvePlugin.mockResolvedValueOnce({ token: "plugin-minimax-token" });
    expect(await resolve(["minimax", "zai"])).toEqual([
      { provider: "minimax", token: "plugin-minimax-token" },
    ]);
    expect(resolvePlugin.mock.calls.map(([params]) => params.provider)).toEqual(["minimax"]);
    expect(loadStore).not.toHaveBeenCalled();
  });

  it("detects usage-only environment credentials", async () => {
    resolvePlugin.mockResolvedValueOnce({ token: "encoded-openai-admin-token" });
    expect(await resolve(["openai"], { OPENAI_ADMIN_KEY: "sk-admin-test" })).toEqual([
      { provider: "openai", token: "encoded-openai-admin-token" },
    ]);
    expect(resolvePlugin.mock.calls.map(([params]) => params.provider)).toEqual(["openai"]);
  });

  it("checks local credential sources without importing external profiles", async () => {
    hasSource.mockReturnValue(true);
    expect(await resolve(["anthropic"])).toEqual([]);
    expect(loadLocalStore).toHaveBeenCalledOnce();
    expect(loadStore).not.toHaveBeenCalled();
    expect(resolvePlugin).not.toHaveBeenCalled();
  });

  it("honors a plugin's refusal instead of falling back to an inference key", async () => {
    resolvePlugin.mockResolvedValueOnce({ handled: true });
    expect(
      await resolve(["anthropic", "zai"], { ANTHROPIC_API_KEY: "fixture-inference-key" }),
    ).toEqual([]);
    expect(resolvePlugin.mock.calls.map(([params]) => params.provider)).toEqual(["anthropic"]);
  });
});
