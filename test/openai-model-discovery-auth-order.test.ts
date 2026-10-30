import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import chutesPlugin from "../extensions/chutes/index.js";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import radiusPlugin from "../extensions/radius/index.js";
import xaiPlugin from "../extensions/xai/index.js";
import {
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "../src/agents/auth-profiles/oauth-refresh-marker.js";
import {
  createExpiredOauthStore,
  readAuthProfileStoreForTest,
} from "../src/agents/auth-profiles/oauth-test-utils.js";
import type { AuthProfileStore, OAuthCredential } from "../src/agents/auth-profiles/types.js";
import { planOpenClawModelsJson } from "../src/agents/models-config.plan.js";
import * as catalogContext from "../src/agents/models-config.providers.catalog-context.js";
import { resolveImplicitProviders } from "../src/agents/models-config.providers.implicit.js";
import { prepareModelCatalogPublication } from "../src/agents/prepared-model-runtime.catalog-publication.js";
import type { ModelProviderConfig } from "../src/config/types.models.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createTestPluginApi } from "../src/plugin-sdk/plugin-test-api.js";
import type { ProviderCatalogOutcome } from "../src/plugins/provider-catalog.types.js";
import * as providerDiscovery from "../src/plugins/provider-discovery.js";
import * as providerRuntime from "../src/plugins/provider-runtime.runtime.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../src/plugins/runtime/gateway-request-scope.js";
import type { ProviderPlugin } from "../src/plugins/types.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";

const discovery = vi.hoisted(() => ({
  providers: new Array<ProviderPlugin>(),
}));

vi.mock("../src/plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

// mock-isolation: Discovery and runtime hooks share fixture providers without real plugin loading.
vi.mock("../src/plugins/provider-hook-runtime.js", async () => {
  const { createProviderHookRuntime } =
    await import("../src/plugins/provider-hook-runtime-core.js");
  const { matchesProviderPluginRef } = await import("../src/plugins/provider-registry-shared.js");
  const selectProviders = (params: {
    onlyPluginIds?: readonly string[];
    providerRefs?: readonly string[];
  }) =>
    discovery.providers.filter(
      (provider) =>
        (!params.onlyPluginIds || params.onlyPluginIds.includes(provider.id)) &&
        (!params.providerRefs?.length ||
          params.providerRefs.some((ref) => matchesProviderPluginRef(provider, ref))),
    );
  return createProviderHookRuntime({
    isPluginProvidersLoadInFlight: () => false,
    resolvePluginProviderRegistryCore: (params) => {
      const providers = selectProviders(params);
      if (providers.length === 0) {
        return undefined;
      }
      return {
        registry: createCatalogProviderRegistry(providers),
        workspaceDir: params.workspaceDir,
        onlyPluginIds: params.onlyPluginIds,
        isProviderOwnerEligible: (pluginId, providerRef) =>
          providers.some(
            (provider) =>
              provider.id === pluginId && matchesProviderPluginRef(provider, providerRef),
          ),
      };
    },
    resolvePluginProvidersCore: (params, onSelectedRegistry) => {
      const providers = selectProviders(params);
      if (providers.length) {
        onSelectedRegistry?.(createCatalogProviderRegistry(providers));
      }
      return providers.map((provider) => Object.assign({}, provider, { pluginId: provider.id }));
    },
  });
});

function createCatalogProviderRegistry(providers = discovery.providers) {
  const registry = createEmptyPluginRegistry();
  registry.providers = providers.map((provider) => ({
    pluginId: provider.id,
    provider,
    source: "test",
  }));
  return registry;
}

function withCatalogProviders<T>(run: () => T): T {
  return withPluginRuntimeRegistryScope(createCatalogProviderRegistry(), run);
}

function registerProvider(plugin: Pick<typeof chutesPlugin, "register">) {
  plugin.register(
    createTestPluginApi({
      registerProvider: (provider) => {
        discovery.providers = [provider];
      },
    }),
  );
}

function authOrder(provider: string, ...profiles: string[]): OpenClawConfig {
  return { auth: { order: { [provider]: profiles } } };
}

function mockRefreshFailure(message = "synthetic OAuth refresh failure") {
  // Diagnostic hints are independent of refresh selection and load the full runtime.
  vi.spyOn(providerRuntime, "buildProviderAuthDoctorHintWithPlugin").mockResolvedValue(undefined);
  return vi
    .spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin")
    .mockRejectedValue(new Error(message));
}

function catalogModel(id: string, name: string, maxTokens = 8_192) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens,
  };
}

function oauthCredential(
  provider: string,
  access: string,
  refresh: string,
  fresh = false,
): OAuthCredential {
  return {
    type: "oauth",
    provider,
    access,
    refresh,
    expires: Date.now() + (fresh ? 3_600_000 : -60_000),
  };
}

function apiKeyCredential(provider: string, key: string) {
  return { type: "api_key" as const, provider, key };
}

let state: OpenClawTestState;
let agentDir: string;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "catalog-auth-order-", agentEnv: "main" });
  agentDir = state.agentDir();
  discovery.providers = [];
  // Keep capability discovery at the mocked refresh boundary, not the full runtime.
  vi.spyOn(providerRuntime, "resolveProviderOAuthRefreshCapabilityWithPlugin").mockResolvedValue({
    status: "available",
  });
});

afterEach(async () => {
  clearLiveCatalogCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  discovery.providers = [];
  await state?.cleanup();
});

describe("Provider model discovery auth preparation", () => {
  beforeEach(() => {
    discovery.providers = [buildOpenAIProvider()];
  });
  function planCatalog(
    config: OpenClawConfig,
    store: AuthProfileStore,
    options: {
      providerId?: string;
      outcomes?: ProviderCatalogOutcome[];
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    return withCatalogProviders(() =>
      planOpenClawModelsJson({
        context: {
          cfg: config,
          discoveryAuthConfig: config,
          sourceConfigForSecrets: config,
          agentDir,
          env: options.env ?? {},
          envFingerprint: {},
          providerDiscoveryProviderIds: [options.providerId ?? "openai"],
          providerDiscoveryTimeoutMs: options.timeoutMs,
          onProviderCatalogOutcome: (outcome) => options.outcomes?.push(outcome),
        },
        authStore: store,
        existingRaw: "",
        existingParsed: null,
      }),
    );
  }

  async function createChutesCatalogFixture() {
    registerProvider(chutesPlugin);
    const profileId = "chutes:oauth";
    const config: OpenClawConfig = { auth: { order: { chutes: [profileId] } } };
    const store = createExpiredOauthStore({
      profileId,
      provider: "chutes",
      access: "expired-chutes-access",
      refresh: "chutes-refresh-token",
    });
    const capturedCredential = structuredClone(store.profiles[profileId]);
    await state.writeAuthProfiles(store);
    const refreshedCredential = oauthCredential(
      "chutes",
      "refreshed-chutes-access",
      "rotated-chutes-refresh-token",
      true,
    );
    return { profileId, config, store, capturedCredential, refreshedCredential };
  }

  function readPlannedProvider(
    plan: Awaited<ReturnType<typeof planOpenClawModelsJson>>,
    providerId: string,
  ): ModelProviderConfig | undefined {
    expect(plan.action).toBe("write");
    return plan.action === "write"
      ? (JSON.parse(plan.contents) as { providers?: Record<string, ModelProviderConfig> })
          .providers?.[providerId]
      : undefined;
  }

  function expectRefresh(
    refresh: MockInstance<typeof providerRuntime.resolveProviderOAuthCredentialWithPlugin>,
    provider: string,
    access: string,
    token: string,
  ) {
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        refresh: true,
        credential: expect.objectContaining({ type: "oauth", provider, access, refresh: token }),
      }),
    );
  }

  it.each([
    { providerId: "openai", source: "profile", modelId: "gpt-5.5" },
    { providerId: "xai", source: "profile", modelId: "grok-4.3" },
    { providerId: "xai", source: "config", modelId: "grok-4.3" },
    { providerId: "xai", source: "env", modelId: "grok-4.3" },
  ])(
    "continues from failed $providerId OAuth to $source API-key auth without repeating refresh",
    async ({ providerId, source, modelId }) => {
      if (providerId === "xai") {
        registerProvider(xaiPlugin);
      }
      const profileA = `${providerId}:oauth-a`;
      const profileB = `${providerId}:api-key-b`;
      const keyB = "selected-profile-b";
      const config = authOrder(providerId, profileA, profileB);
      const store = createExpiredOauthStore({
        profileId: profileA,
        provider: providerId,
        access: "rejected-oauth-a",
        refresh: "refresh-a",
      });
      if (source === "profile") {
        store.profiles[profileB] = apiKeyCredential(providerId, keyB);
      } else if (source === "config") {
        config.models = {
          providers: {
            [providerId]: {
              baseUrl: "https://api.x.ai/v1",
              api: "openai-responses",
              apiKey: keyB,
              models: [],
            },
          },
        };
      } else {
        vi.stubEnv("XAI_API_KEY", keyB);
      }
      await state.writeAuthProfiles(store);
      const events: string[] = [];
      // Diagnostic copy is independent of refresh selection and loads the full plugin runtime.
      vi.spyOn(providerRuntime, "buildProviderAuthDoctorHintWithPlugin").mockResolvedValue(
        undefined,
      );
      const refresh = vi
        .spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin")
        .mockImplementation(async ({ credential }) => {
          events.push(`refresh:${credential.access}`);
          throw new Error("synthetic OAuth refresh failure");
        });
      const { resolveApiKeyForProvider } = providerAuthRuntime;
      const runtimeAuth = vi
        .spyOn(providerAuthRuntime, "resolveApiKeyForProvider")
        .mockImplementation(async (params) => {
          events.push(`resolve:${params.profileId}`);
          return resolveApiKeyForProvider(params);
        });
      const requests: string[] = [];
      const outcomes: ProviderCatalogOutcome[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        events.push("catalog");
        requests.push(new Headers(init?.headers).get("authorization") ?? "");
        const url = new URL(input instanceof Request ? input.url : input);
        return Response.json(
          url.hostname === "chatgpt.com"
            ? { models: [] }
            : { data: [{ id: modelId, object: "model" }] },
        );
      });

      const plan = await planCatalog(config, store, {
        providerId,
        outcomes,
        ...(source === "env" ? { env: { XAI_API_KEY: keyB } } : {}),
      });

      expect(
        providerRuntime.resolveProviderOAuthRefreshCapabilityWithPlugin,
      ).toHaveBeenCalledOnce();
      expect(providerRuntime.resolveProviderOAuthRefreshCapabilityWithPlugin).toHaveBeenCalledWith(
        expect.objectContaining({ provider: providerId }),
      );
      expectRefresh(refresh, providerId, "rejected-oauth-a", "refresh-a");
      const resolvedProfile = source === "profile" ? profileB : undefined;
      const catalogRequests = providerId === "openai" ? 2 : 1;
      expect(events).toEqual([
        "refresh:rejected-oauth-a",
        "resolve:" + resolvedProfile,
        ...Array.from({ length: catalogRequests }, () => "catalog"),
      ]);
      expect({
        runtimeProfiles: runtimeAuth.mock.calls.map(([params]) => ({
          profileId: params.profileId,
          lockedProfile: params.lockedProfile,
        })),
        requests,
        outcomes,
        action: plan.action,
      }).toEqual({
        runtimeProfiles: [
          { profileId: resolvedProfile, lockedProfile: resolvedProfile ? true : undefined },
        ],
        requests: Array.from({ length: catalogRequests }, () => "Bearer " + keyB),
        outcomes: [
          {
            provider: providerId,
            ...(resolvedProfile ? { profileId: resolvedProfile } : {}),
            status: "ready",
          },
        ],
        action: "write",
      });
      expect(plan.action === "write" ? plan.contents : "").not.toContain("rejected-oauth-a");
    },
  );

  it.each(["oauth", "api_key"] as const)(
    "plans the registered Radius catalog with the selected %s credential",
    async (mode) => {
      registerProvider(radiusPlugin);
      vi.mocked(providerRuntime.resolveProviderOAuthRefreshCapabilityWithPlugin).mockRestore();
      const profileId = "radius:oauth";
      const keyProfileId = "radius:key";
      const store = createExpiredOauthStore({
        profileId,
        provider: "radius",
        access: "expired-radius-access",
        refresh: "radius-refresh-token",
      });
      store.profiles[keyProfileId] = apiKeyCredential("radius", "selected-radius-key");
      const captured = structuredClone(store);
      await state.writeAuthProfiles(store);
      const persisted = readAuthProfileStoreForTest(agentDir).profiles[profileId];
      if (!persisted) {
        throw new Error("Missing saved Radius OAuth profile");
      }
      const config: OpenClawConfig = {
        auth: { order: { radius: mode === "oauth" ? [profileId] : [keyProfileId, profileId] } },
      };
      const selectedAccess = mode === "oauth" ? "refreshed-radius-access" : "selected-radius-key";
      const requests: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (typeof input !== "string") {
          throw new Error("Expected a Radius request URL");
        }
        if (input === "https://radius.pi.dev/v1/oauth/token") {
          requests.push("refresh");
          if (!(init?.body instanceof URLSearchParams)) {
            throw new Error("Expected a Radius token request form");
          }
          expect(init.body.get("refresh_token")).toBe("radius-refresh-token");
          return Response.json({
            access_token: "refreshed-radius-access",
            refresh_token: "rotated-radius-refresh-token",
            expires_in: 3600,
          });
        }
        expect(input).toBe("https://radius.pi.dev/v1/config");
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        requests.push(authorization);
        return authorization === `Bearer ${selectedAccess}`
          ? Response.json({
              baseUrl: "https://radius.pi.dev/v1",
              models: [catalogModel("organization-model", "Organization Model", 4096)],
            })
          : new Response("unauthorized", { status: 401 });
      });

      const plan = await planCatalog(config, store, { providerId: "radius" });

      expect(requests).toEqual([
        ...(mode === "oauth" ? ["refresh"] : []),
        `Bearer ${selectedAccess}`,
      ]);
      expect(readPlannedProvider(plan, "radius")?.models.map((model) => model.id)).toEqual([
        "organization-model",
      ]);
      expect(store).toEqual(captured);
      expect(readAuthProfileStoreForTest(agentDir).profiles[profileId]).toMatchObject(
        mode === "oauth"
          ? { access: selectedAccess, refresh: "rotated-radius-refresh-token" }
          : persisted,
      );
      expect(plan.action === "write" ? plan.contents : "").not.toContain("refreshed-radius-access");
    },
  );

  it.each([
    { providerId: "chutes", profileCount: 2, plugin: chutesPlugin },
    { providerId: "openai", profileCount: 1, plugin: null },
    { providerId: "xai", profileCount: 2, plugin: xaiPlugin },
  ])(
    "retains the $providerId catalog when all $profileCount OAuth profiles fail preparation",
    async ({ providerId, profileCount, plugin }) => {
      if (plugin) {
        registerProvider(plugin);
      }
      const profileIds = Array.from(
        { length: profileCount },
        (_, index) => `${providerId}:oauth-${index}`,
      );
      const profiles = Object.fromEntries(
        profileIds.map((profileId) => [
          profileId,
          oauthCredential(providerId, `expired-${profileId}`, `refresh-${profileId}`),
        ]),
      );
      const store: AuthProfileStore = { version: 1, profiles };
      const config: OpenClawConfig = { auth: { order: { [providerId]: profileIds } } };
      await state.writeAuthProfiles(store);
      const refresh = mockRefreshFailure();
      const runtimeAuth = vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider");
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP"));
      const outcomes: ProviderCatalogOutcome[] = [];
      const previousProfileId = profileIds[profileIds.length - 1];
      const previousCredential = previousProfileId && profiles[previousProfileId];
      if (!previousProfileId || !previousCredential) {
        throw new Error("OAuth fixture requires a previous profile");
      }
      const auth = {
        authStore: store,
        providerAuthLabels: new Map(),
        authModes: { [providerId]: "oauth" as const },
        credentials: { [providerId]: previousCredential },
      };
      const priorModel = {
        id: "prior-account-only-model",
        name: "Prior Account Model",
        provider: providerId,
      };
      const previous = prepareModelCatalogPublication(
        {
          entries: [priorModel],
          routeVariants: [],
          providerOutcomes: [
            { provider: providerId, profileId: previousProfileId, status: "ready" },
          ],
        },
        new Map(),
        undefined,
        auth,
        (provider) => provider,
      );

      const plan = await planCatalog(config, store, { providerId, outcomes });
      const published = prepareModelCatalogPublication(
        {
          entries: [],
          routeVariants: [],
          staticEntries: readPlannedProvider(plan, providerId)?.models.map((model) =>
            Object.assign(model, { provider: providerId }),
          ),
          providerOutcomes: outcomes,
        },
        new Map(),
        { ...previous, providers: new Map() },
        auth,
        (provider) => provider,
      );

      expect(published.catalog.entries).toContainEqual(priorModel);
      expect(published.discoveryOrigins).toEqual(previous.discoveryOrigins);
      expect(outcomes).toEqual(
        profileIds.map((profileId) => ({ provider: providerId, profileId, status: "unavailable" })),
      );
      expect(refresh).toHaveBeenCalledTimes(profileCount);
      expect(runtimeAuth).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { completion: "success", timedOut: true },
    { completion: "failure", timedOut: true },
    { completion: "failure", timedOut: false },
  ] as const)(
    "keeps OAuth preparation bounded after $completion (timeout: $timedOut)",
    async ({ completion, timedOut }) => {
      const { profileId, config, store, capturedCredential, refreshedCredential } =
        await createChutesCatalogFixture();
      const fallbackProfileId = "chutes:fallback";
      const fallbackCredential = oauthCredential(
        "chutes",
        "expired-fallback-access",
        "fallback-refresh-token",
      );
      const refreshedFallback = oauthCredential(
        "chutes",
        "refreshed-fallback-access",
        "rotated-fallback-refresh-token",
        true,
      );
      config.auth = { order: { chutes: [profileId, fallbackProfileId] } };
      store.profiles[fallbackProfileId] = fallbackCredential;
      await state.writeAuthProfiles(store);
      const refreshStarted = createDeferredCore();
      const refreshResult =
        createDeferredCore<
          Awaited<ReturnType<typeof providerRuntime.resolveProviderOAuthCredentialWithPlugin>>
        >();
      vi.spyOn(providerRuntime, "buildProviderAuthDoctorHintWithPlugin").mockResolvedValue(
        undefined,
      );
      const refresh = vi
        .spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin")
        .mockImplementation(async ({ credential }) => {
          if (credential.access !== fallbackCredential.access) {
            refreshStarted.resolve();
            return refreshResult.promise;
          }
          return {
            status: "available",
            credential: refreshedFallback,
            apiKey: refreshedFallback.access,
          };
        });
      const preparation = vi.spyOn(catalogContext, "prepareProviderCatalogRun");
      const catalog = vi.spyOn(providerDiscovery, "runProviderCatalog");
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ data: [{ id: "late-account-model" }] }));
      const outcomes: ProviderCatalogOutcome[] = [];
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const planning = planCatalog(config, store, {
        providerId: "chutes",
        timeoutMs: timedOut ? 25 : undefined,
        outcomes,
      });

      try {
        await refreshStarted.promise;
        if (timedOut) {
          await vi.advanceTimersByTimeAsync(25);
          const plan = await planning;
          expect(outcomes).toEqual([{ provider: "chutes", status: "unavailable" }]);
          expect(readPlannedProvider(plan, "chutes")?.models.length).toBeGreaterThan(0);
        }
        expect(refresh).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        try {
          if (completion === "success") {
            refreshResult.resolve({
              status: "available",
              credential: refreshedCredential,
              apiKey: refreshedCredential.access,
            });
          } else {
            refreshResult.reject(new Error("synthetic OAuth refresh failure"));
          }
          // Join the real refresh owner so late credential persistence and I/O are observable.
          const completedPreparation = await Promise.allSettled(
            preparation.mock.results.map((result) => result.value),
          );
          await Promise.allSettled(catalog.mock.results.map((result) => result.value));
          expect(completedPreparation).toEqual([expect.objectContaining({ status: "fulfilled" })]);
        } finally {
          vi.useRealTimers();
        }
      }

      const plan = await planning;
      for (const secret of [
        "expired-chutes-access",
        "chutes-refresh-token",
        refreshedCredential.access,
        refreshedCredential.refresh,
      ]) {
        expect(plan.action === "write" ? plan.contents : "").not.toContain(secret);
      }
      expect(refresh.mock.calls.map(([params]) => params.credential)).toEqual(
        timedOut ? [capturedCredential] : [capturedCredential, fallbackCredential],
      );
      const persisted = readAuthProfileStoreForTest(agentDir);
      const persistedProfile = persisted.profiles[profileId];
      if (completion === "success") {
        expect(persistedProfile).toMatchObject(refreshedCredential);
      } else {
        expect(persistedProfile?.type === "oauth" && isOAuthRefreshFence(persistedProfile)).toBe(
          true,
        );
        expect(
          persistedProfile?.type === "oauth" && isPendingOAuthRefreshFence(persistedProfile),
        ).toBe(false);
      }
      expect(persisted.profiles[fallbackProfileId]).toMatchObject(
        timedOut ? fallbackCredential : refreshedFallback,
      );
      expect(store.profiles[profileId]).toEqual(capturedCredential);
      expect(store.profiles[fallbackProfileId]).toEqual(fallbackCredential);
      expect(preparation).toHaveBeenCalledOnce();
      if (timedOut) {
        expect(catalog).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(outcomes).toEqual([{ provider: "chutes", status: "unavailable" }]);
      } else {
        expect(catalog).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledOnce();
        expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
          `Bearer ${refreshedFallback.access}`,
        );
        expect(outcomes).toEqual([
          { provider: "chutes", profileId: fallbackProfileId, status: "ready" },
        ]);
        expect(readPlannedProvider(plan, "chutes")?.models.map((model) => model.id)).toContain(
          "late-account-model",
        );
      }
    },
  );

  it.each(["outcome", "provider"] as const)(
    "preserves a plugin-owned %s after probing exhausted OAuth",
    async (resultKind) => {
      const { config, store } = await createChutesCatalogFixture();
      const otherProfileId = "openai:other-source";
      store.profiles[otherProfileId] = apiKeyCredential("openai", "independent-source-key");
      await state.writeAuthProfiles(store);
      mockRefreshFailure();
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP"));
      const provider = discovery.providers[0];
      if (!provider) {
        throw new Error("Chutes fixture did not register a provider");
      }
      const independentModel = catalogModel("independent-source-model", "Independent Source Model");
      const explicitOutcome: ProviderCatalogOutcome = {
        provider: "chutes",
        profileId: otherProfileId,
        status: "unavailable",
      };
      let reads = 0;
      provider.catalog = {
        order: "profile",
        run: async (ctx) => {
          ctx.resolveProviderAuth("CHUTES");
          const other = ctx.resolveProviderAuth("openai");
          expect(other.profileId).toBe(otherProfileId);
          expect(other.preparationFailed).not.toBe(true);
          if (resultKind === "outcome") {
            return {
              providers: {},
              get outcomes() {
                return reads++ === 0 ? [explicitOutcome] : [];
              },
            };
          }
          return {
            get provider() {
              return {
                baseUrl: "https://api.chutes.ai/v1",
                apiKey: other.apiKey,
                models: reads++ === 0 ? [independentModel] : [],
              };
            },
          };
        },
      };
      const outcomes: ProviderCatalogOutcome[] = [];

      const plan = await planCatalog(config, store, { providerId: "chutes", outcomes });

      if (resultKind === "outcome") {
        expect(outcomes).toEqual([explicitOutcome]);
      } else {
        expect(outcomes).toEqual([]);
        expect(readPlannedProvider(plan, "chutes")?.models.map((model) => model.id)).toContain(
          independentModel.id,
        );
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("provider catalog late-result finalization", () => {
  const providerId = "catalog-late-fixture";
  const profileId = `${providerId}:oauth`;
  const peerId = "catalog-peer-fixture";
  const model = catalogModel("account-only", "Account Model");

  let store: AuthProfileStore;

  beforeEach(async () => {
    store = {
      version: 1,
      profiles: {
        [profileId]: oauthCredential(providerId, "expired-fixture-access", "fixture-refresh"),
      },
    };
    await state.writeAuthProfiles(store);
    mockRefreshFailure("fixture refresh failed");
  });

  it.each(["provider", "providers", "outcomes"] as const)(
    "discards late %s and consumes the next active owner's result once",
    async (shape) => {
      const entered = createDeferredCore();
      const completion = createDeferredCore();
      const catalog = vi.spyOn(providerDiscovery, "runProviderCatalog");
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP"));
      const ready: ProviderCatalogOutcome[] = [{ provider: providerId, status: "ready" }];
      if (shape === "providers") {
        ready.push({ provider: peerId, status: "ready" });
      }
      let reads = 0;
      const readProvider = (): ModelProviderConfig => ({
        baseUrl: "https://catalog.invalid/v1",
        api: "openai-completions",
        models: reads++ === 0 ? [model] : [],
      });
      discovery.providers = [
        {
          id: providerId,
          label: "Catalog Fixture",
          auth: [
            {
              id: "oauth",
              label: "OAuth",
              kind: "oauth",
              run: async () => {
                throw new Error("interactive auth is outside this fixture");
              },
            },
          ],
          catalog: {
            run: async (ctx) => {
              expect(ctx.resolveProviderAuth(providerId).preparationFailed).toBe(true);
              entered.resolve();
              await completion.promise;
              if (shape === "outcomes") {
                return {
                  providers: {},
                  get outcomes() {
                    return reads++ === 0 ? ready : [];
                  },
                };
              }
              return shape === "provider"
                ? {
                    get provider() {
                      return readProvider();
                    },
                    outcomes: ready,
                  }
                : {
                    get providers() {
                      const provider = readProvider();
                      return { [providerId]: provider, [peerId]: provider };
                    },
                    outcomes: ready,
                  };
            },
          },
        },
      ];
      const outcomes: ProviderCatalogOutcome[] = [];
      const discover = (timeoutMs?: number) =>
        withCatalogProviders(() =>
          resolveImplicitProviders({
            config: { auth: { order: { [providerId]: [profileId] } } },
            agentDir: state.agentDir(),
            authStore: store,
            env: {},
            providerDiscoveryTimeoutMs: timeoutMs,
            onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
          }),
        );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = discover(25);
      try {
        await Promise.race([entered.promise, pending]);
        await vi.advanceTimersByTimeAsync(25);
        expect(await pending).toEqual({});
      } finally {
        completion.resolve();
        await Promise.allSettled(catalog.mock.results.map((result) => result.value));
      }
      const lateReads = reads;
      expect(outcomes).toEqual([{ provider: providerId, status: "unavailable" }]);
      outcomes.length = 0;
      const accepted = await discover();
      expect({ lateReads, reads }).toEqual({ lateReads: 0, reads: 1 });
      if (shape === "outcomes") {
        expect(accepted).toEqual({});
      } else {
        expect(accepted?.[providerId]?.models).toEqual([model]);
      }
      if (shape === "providers") {
        expect(accepted?.[peerId]?.models).toEqual([model]);
      }
      expect(outcomes).toEqual(ready);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
