import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { readConfiguredLogTail } from "../logging/log-tail.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
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

// mock-isolation: Plugin auth precedence uses seeded stores and source flags without host credential discovery.
vi.mock("../agents/auth-profiles.js", () => ({
  dedupeProfileIds: (ids: string[]) => [...new Set(ids)],
  ensureAuthProfileStore: () => loadStore(),
  ensureAuthProfileStoreAsync: () => loadStore(),
  ensureAuthProfileStoreWithoutExternalProfilesAsync: () => loadLocalStore(),
  hasAnyAuthProfileStoreSourceAsync: () => hasSource(),
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
  const logPaths = createSuiteLogPathTracker("openclaw-usage-auth-");
  beforeAll(() => logPaths.setup());
  afterAll(() => logPaths.cleanup());
  afterEach(async () => {
    await testApi.flushFileLogQueueForTests();
    setLoggerOverride(null);
    resetLogger();
  });

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
      const token = (
        await context.resolveApiKeyCandidatesFromConfigAndStore?.({
          envDirect: [undefined, "first-\r\nkey", "second-key"],
        })
      )?.[0];
      return token ? { token } : undefined;
    });
    expect(await resolve(["zai"], { ZAI_API_KEY: "fallback-key" })).toEqual([
      { provider: "zai", token: "first-key" },
    ]);
  });

  it("keeps the supplied store when direct credentials admit a legacy usage hook", async () => {
    const profileId = "anthropic:scoped";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: { type: "api_key", provider: "anthropic", key: "scoped-key" },
      },
    };
    const getStore = vi.fn(async () => store);
    loadStore.mockReturnValue({
      version: 1,
      profiles: {
        [profileId]: { type: "api_key", provider: "anthropic", key: "ambient-key" },
      },
    });
    order.mockImplementation(({ provider }) => (provider === "anthropic" ? [profileId] : []));
    resolvePlugin.mockImplementationOnce(async ({ context }) => {
      const token = context.resolveApiKeyFromConfigAndStore({ providerIds: ["anthropic"] });
      return token ? { token } : undefined;
    });

    await expect(
      resolveProviderAuths({
        providers: ["zai"],
        env: { ZAI_API_KEY: "direct-key" },
        config: {},
        agentDir: "/tmp/openclaw-agent",
        getStore,
      }),
    ).resolves.toEqual([{ provider: "zai", token: "scoped-key" }]);
    expect(getStore).toHaveBeenCalledOnce();
    expect(loadStore).not.toHaveBeenCalled();
    expect(loadLocalStore).not.toHaveBeenCalled();
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

  it.each(["debug", "info", "cancel"] as const)(
    "diagnoses skipped OAuth profiles without changing selection or cancellation (%s)",
    async (mode) => {
      setLoggerOverride({
        level: mode === "info" ? "info" : "debug",
        consoleLevel: "silent",
        file: logPaths.nextPath(),
      });
      const store = seed(
        {
          "anthropic:broken": { type: "token", provider: "anthropic", token: "broken-token" },
          "anthropic:working": { type: "token", provider: "anthropic", token: "working-token" },
        },
        { anthropic: ["anthropic:broken", "anthropic:working"] },
      );
      const controller = new AbortController();
      const cancelled = new Error("usage cancelled");
      const secret = "synthetic-usage-secret-1234";
      resolveKey.mockImplementation(async ({ profileId }) => {
        if (profileId === "anthropic:broken") {
          if (mode === "cancel") {
            controller.abort(cancelled);
          }
          throw new Error(`missing fixture credential; Authorization: Bearer ${secret}`);
        }
        return { apiKey: "working-token", provider: "anthropic" };
      });
      resolvePlugin.mockImplementationOnce(
        async ({ context }) => (await context.resolveOAuthToken()) ?? undefined,
      );
      const result = resolveProviderAuths({
        providers: ["anthropic"],
        store,
        env: {},
        config: {},
        signal: controller.signal,
      });
      if (mode === "cancel") {
        await expect(result).rejects.toBe(cancelled);
      } else {
        await expect(result).resolves.toEqual([{ provider: "anthropic", token: "working-token" }]);
      }
      await testApi.flushFileLogQueueForTests();
      const { lines } = await readConfiguredLogTail();
      const diagnostics = lines.filter((line) => line.includes("usage auth: skipped auth profile"));
      if (mode === "debug") {
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toContain("anthropic:broken");
        expect(diagnostics[0]).toContain("missing fixture credential");
        expect(diagnostics[0]).not.toContain(secret);
      } else {
        expect(diagnostics).toEqual([]);
      }
    },
  );
});
