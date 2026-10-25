import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
/** Exercises provider runtime loading, ordering, and manifest-backed discovery paths. */
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "./plugin-metadata.test-support.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import {
  createProviderRuntimeLogger,
  DEMO_SANITIZED_MESSAGE,
  DEMO_TOOL,
  PROVIDER_RUNTIME_TEST_MODEL as MODEL,
} from "./provider-runtime.test-support.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { setPluginRuntimeLoadContext } from "./runtime/load-context.js";
import type { ProviderPlugin } from "./types.js";

type ResolvePluginProviders = typeof import("./providers.runtime.js").resolvePluginProvidersCore;
type IsPluginProvidersLoadInFlight =
  typeof import("./providers.runtime.js").isPluginProvidersLoadInFlight;
type ResolveCatalogHookProviderPluginIds =
  typeof import("./providers.js").resolveCatalogHookProviderPluginIds;
type ResolveUsageHookProviderPluginContracts =
  typeof import("./providers.js").resolveUsageHookProviderPluginContracts;
type ResolveExternalAuthProfileProviderPluginIds =
  typeof import("./providers.js").resolveExternalAuthProfileProviderPluginIds;
type ResolveOwningPluginIdsForProvider =
  typeof import("./providers.js").resolveOwningPluginIdsForProvider;
type ResolveBundledProviderPolicySurface =
  typeof import("./provider-public-artifacts.js").resolveBundledProviderPolicySurface;
type ResolveProviderPolicySurface =
  typeof import("./provider-public-artifacts.js").resolveProviderPolicySurface;

const resolvePluginProvidersMock = vi.fn<ResolvePluginProviders>().mockReturnValue([]);
const isPluginProvidersLoadInFlightMock = vi
  .fn<IsPluginProvidersLoadInFlight>()
  .mockReturnValue(false);
const resolveCatalogHookProviderPluginIdsMock = vi
  .fn<ResolveCatalogHookProviderPluginIds>()
  .mockReturnValue([]);
const resolveUsageHookProviderPluginContractsMock = vi
  .fn<ResolveUsageHookProviderPluginContracts>()
  .mockReturnValue([]);
const resolveExternalAuthProfileProviderPluginIdsMock = vi
  .fn<ResolveExternalAuthProfileProviderPluginIds>()
  .mockReturnValue([]);
const resolveOwningPluginIdsForProviderMock = vi.fn<ResolveOwningPluginIdsForProvider>();
const resolveBundledProviderPolicySurfaceMock = vi
  .fn<ResolveBundledProviderPolicySurface>()
  .mockReturnValue(null);
const resolveProviderPolicySurfaceMock = vi
  .fn<ResolveProviderPolicySurface>()
  .mockReturnValue(null);
const providerRuntimeWarnMock = vi.fn();

let runtime: typeof import("./provider-runtime.js");
let getAiTransportHost: typeof import("@openclaw/ai").getAiTransportHost;
let attachModelProviderRuntimePluginHandle: typeof import("./provider-hook-runtime.js").attachModelProviderRuntimePluginHandle;
let resolveProviderPluginsForHooks: typeof import("./provider-hook-runtime.js").resolveProviderPluginsForHooks;
let resolveLoadedProviderPluginsForHooks: typeof import("./provider-hook-runtime.js").resolveLoadedProviderPluginsForHooks;
let resolvePreparedExtraParams: typeof import("../agents/embedded-agent-runner/extra-params.js").resolvePreparedExtraParams;
let createEmptyPluginRegistry: typeof import("./registry-empty.js").createEmptyPluginRegistry;
let resetPluginRuntimeStateForTest: typeof import("./runtime.js").resetPluginRuntimeStateForTest;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;

const DEMO_PROVIDER_ID = "demo";
const EMPTY_MODEL_REGISTRY = { find: () => null } as never;
const DEMO_REPLAY_MESSAGES: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];

function createDemoProvider(overrides: Partial<ProviderPlugin> = {}): ProviderPlugin {
  return { id: DEMO_PROVIDER_ID, label: "Demo", auth: [], ...overrides };
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function getLastResolvePluginProvidersParams() {
  const calls = resolvePluginProvidersMock.mock.calls;
  return requireRecord(calls[calls.length - 1]?.[0], "provider load params");
}

function createDemoRuntimeContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string; modelId: string } {
  return {
    provider: DEMO_PROVIDER_ID,
    modelId: MODEL.id,
    ...overrides,
  };
}

function createDemoProviderContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string } {
  return {
    provider: DEMO_PROVIDER_ID,
    ...overrides,
  };
}

function createDemoResolvedModelContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string; modelId: string; model: ProviderRuntimeModel } {
  return createDemoRuntimeContext({
    model: MODEL,
    ...overrides,
  });
}

function registerLoadedProviders(providers: ProviderPlugin[], startupWorkspaceDir?: string) {
  const registry = createEmptyPluginRegistry();
  registry.providers = providers.map((provider) => ({
    pluginId: provider.id,
    provider,
    source: "test",
  }));
  if (startupWorkspaceDir === undefined) {
    setActivePluginRegistry(registry);
  } else {
    setActivePluginRegistry(registry, "startup-registry", "gateway-bindable", startupWorkspaceDir);
  }
}

function allowOnlyMockOpenAiProviderLoad() {
  resolvePluginProvidersMock.mockImplementation((params) => {
    if (params.providerRefs?.includes("mock-openai")) {
      return [];
    }
    throw new Error("unexpected broad provider hook scan");
  });
}

describe("provider-runtime", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("./provider-public-artifacts.js", () => ({
      resolveBundledProviderPolicySurface: (
        ...args: Parameters<ResolveBundledProviderPolicySurface>
      ) => resolveBundledProviderPolicySurfaceMock(...args),
      resolveProviderPolicySurface: (...args: Parameters<ResolveProviderPolicySurface>) =>
        resolveProviderPolicySurfaceMock(...args),
    }));
    vi.doMock("./providers.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./providers.js")>()),
      resolveCatalogHookProviderPluginIds: resolveCatalogHookProviderPluginIdsMock,
      resolveUsageHookProviderPluginContracts: resolveUsageHookProviderPluginContractsMock,
      resolveExternalAuthProfileProviderPluginIds: resolveExternalAuthProfileProviderPluginIdsMock,
      resolveOwningPluginIdsForProvider: resolveOwningPluginIdsForProviderMock,
      resolveOwningPluginIdsForProviderRef: resolveOwningPluginIdsForProviderMock,
      resolveProviderRefOwnership: (params: unknown) => {
        const pluginIds = resolveOwningPluginIdsForProviderMock(params as never);
        return pluginIds?.length ? { status: "owned", pluginIds } : { status: "unowned" };
      },
    }));
    vi.doMock("./providers.runtime.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./providers.runtime.js")>();
      const resolveRegistry = (params: Parameters<ResolvePluginProviders>[0]) => {
        const loaded = actual.resolvePluginProviderRegistryCore({
          ...params,
          registryScope: "loaded",
        });
        if (loaded || params.registryScope === "loaded") {
          return loaded;
        }
        if (params.skipIfLoadInFlight && isPluginProvidersLoadInFlightMock(params)) {
          return undefined;
        }
        const providers = resolvePluginProvidersMock(params);
        if (providers.length === 0) {
          return undefined;
        }
        const registry = createEmptyPluginRegistry();
        registry.providers = providers.map((provider) => ({
          pluginId: provider.pluginId ?? provider.id,
          provider,
          source: "synthetic-provider",
        }));
        return { registry, onlyPluginIds: undefined, isProviderOwnerEligible: () => true };
      };
      return {
        ...actual,
        resolvePluginProviderRegistryCore: resolveRegistry,
        resolvePluginProvidersCore: (params: Parameters<ResolvePluginProviders>[0]) => {
          const selection = resolveRegistry(params);
          if (!selection) {
            return [];
          }
          return selection.registry.providers
            .filter(
              (entry) =>
                !selection.onlyPluginIds || selection.onlyPluginIds.includes(entry.pluginId),
            )
            .map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId }));
        },
        isPluginProvidersLoadInFlight: (params: Parameters<IsPluginProvidersLoadInFlight>[0]) =>
          isPluginProvidersLoadInFlightMock(params),
      };
    });
    vi.doMock("./provider-hook-runtime.js", async () => {
      const { createProviderHookRuntime } = await import("./provider-hook-runtime-core.js");
      const providers = await import("./providers.runtime.js");
      return createProviderHookRuntime(providers);
    });
    vi.doMock("./provider-external-auth.js", async () => {
      const { createProviderExternalAuthResolver } =
        await import("./provider-external-auth-core.js");
      const hooks = await import("./provider-hook-runtime.js");
      return createProviderExternalAuthResolver(hooks);
    });
    vi.doMock("../logging/subsystem.js", () => ({
      createSubsystemLogger: () => createProviderRuntimeLogger(providerRuntimeWarnMock),
    }));
    runtime = await import("./provider-runtime.js");
    ({ resolvePreparedExtraParams } =
      await import("../agents/embedded-agent-runner/extra-params.js"));
    ({
      attachModelProviderRuntimePluginHandle,
      resolveProviderPluginsForHooks,
      resolveLoadedProviderPluginsForHooks,
    } = await import("./provider-hook-runtime.js"));
    await import("../agents/ai-transport-runtime-host.js");
    ({ getAiTransportHost } = await import("@openclaw/ai"));
    ({ createEmptyPluginRegistry } = await import("./registry-empty.js"));
    ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } = await import("./runtime.js"));
  });

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    resolvePluginProvidersMock.mockReset().mockReturnValue([]);
    isPluginProvidersLoadInFlightMock.mockReset().mockReturnValue(false);
    resolveCatalogHookProviderPluginIdsMock.mockReset().mockReturnValue([]);
    resolveUsageHookProviderPluginContractsMock.mockReset().mockReturnValue([]);
    resolveExternalAuthProfileProviderPluginIdsMock.mockReset().mockReturnValue([]);
    resolveOwningPluginIdsForProviderMock.mockReset().mockReturnValue(undefined);
    resolveBundledProviderPolicySurfaceMock.mockReset().mockReturnValue(null);
    resolveProviderPolicySurfaceMock.mockReset().mockReturnValue(null);
    providerRuntimeWarnMock.mockReset();
  });

  it.each([true, false])("dispatches session OAuth with owner available=%s", async (available) => {
    const refreshConfig: OpenClawConfig = {
      models: {
        providers: {
          "plugin-oauth": { baseUrl: "https://caller.example.com/anthropic", models: [] },
        },
      },
    };
    const provider = createDemoProvider({
      id: "plugin-oauth",
      loginOAuth: async () => ({ access: "login-access", refresh: "login-refresh", expires: 123 }),
      refreshOAuth: async (credential, config) => ({
        ...credential,
        access:
          config?.models?.providers?.["plugin-oauth"]?.baseUrl ===
          "https://caller.example.com/anthropic"
            ? "refreshed-access"
            : "wrong-region-access",
      }),
      formatApiKey: (credential) =>
        credential.type === "oauth" ? `formatted:${credential.access}` : "",
    });
    if (!available) {
      resolveOwningPluginIdsForProviderMock.mockReturnValue(["plugin-oauth"]);
    }
    resolvePluginProvidersMock.mockReturnValue(available ? [provider] : []);

    const login = await runtime.loginProviderOAuthWithPlugin({
      provider: "plugin-oauth",
      context: { onAuth: vi.fn(), onPrompt: vi.fn(async () => "") },
    });
    const credential = await runtime.resolveProviderOAuthCredentialWithPlugin({
      provider: "plugin-oauth",
      ...(available ? { config: refreshConfig } : {}),
      credential: {
        type: "oauth",
        provider: "plugin-oauth",
        access: "old-access",
        refresh: "refresh",
        expires: 1,
      },
      refresh: true,
    });
    if (available) {
      expect(login).toMatchObject({
        status: "available",
        credentials: { access: "login-access", refresh: "login-refresh" },
      });
      expect(credential).toMatchObject({
        status: "available",
        apiKey: "formatted:refreshed-access",
        credential: { access: "refreshed-access" },
      });
    } else {
      expect(login).toEqual({ status: "configured-unavailable" });
      expect(credential).toEqual({ status: "configured-unavailable" });
    }
    expect(
      runtime.resolveProviderOAuthRefreshCapabilityWithPlugin({ provider: "plugin-oauth" }),
    ).toEqual({
      status: available ? "available" : "configured-unavailable",
    });
  });

  it("auto-discovers only usage providers declared by their owning plugin", () => {
    resolveUsageHookProviderPluginContractsMock.mockReturnValue([
      { pluginId: "multi-provider", providerIds: ["declared"] },
    ]);
    expect(runtime.listProviderUsagePluginDescriptors({ env: process.env })).toEqual([
      { provider: "declared", displayName: "declared" },
    ]);
    // Manifest contracts answer discovery; descriptor listing must not load plugin runtime.
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("retries empty runtime handles with context model refs", () => {
    const resolveSystemPromptContribution = vi.fn(() => ({
      stablePrefix: "anthropic cli prompt",
    }));
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        hookAliases: ["claude-cli"],
        auth: [],
        resolveSystemPromptContribution,
      },
    ]);

    const contribution = runtime.resolveProviderSystemPromptContribution({
      provider: "claude-cli",
      runtimeHandle: {
        provider: "claude-cli",
        plugin: undefined,
      },
      context: {
        provider: "claude-cli",
        modelId: "claude-sonnet-4-6",
        promptMode: "full",
      },
    });

    expect(contribution?.stablePrefix).toBe("anthropic cli prompt");
    expect(getLastResolvePluginProvidersParams()).toMatchObject({
      providerRefs: ["claude-cli"],
      modelRefs: ["claude-cli/claude-sonnet-4-6", "claude-sonnet-4-6"],
    });
  });

  it("uses the active startup registry for provider hook lookup", () => {
    const provider: ProviderPlugin = createDemoProvider({
      classifyFailoverReason: () => "billing",
      prepareExtraParams: ({ extraParams }) => ({
        ...extraParams,
        fromActiveRegistry: true,
      }),
    });
    registerLoadedProviders([provider], "/tmp/workspace");

    expect(
      resolvePreparedExtraParams({
        cfg: undefined,
        provider: DEMO_PROVIDER_ID,
        modelId: MODEL.id,
        workspaceDir: "/tmp/workspace",
      }),
    ).toEqual({
      fromActiveRegistry: true,
    });
    expect(
      runtime.classifyProviderFailoverSignalWithPlugin({
        provider: DEMO_PROVIDER_ID,
        workspaceDir: "/tmp/workspace",
        context: createDemoProviderContext({ status: 403, errorMessage: "fixture refusal" }),
      }),
    ).toBe("billing");
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reads retired auth profiles without activating runtime (loaded=%s)",
    (loaded) => {
      const provider = createDemoProvider({ deprecatedProfileIds: ["demo:retired"] });
      resolvePluginProvidersMock.mockReturnValue([provider]);
      if (loaded) {
        registerLoadedProviders([provider], "/tmp/workspace");
      }
      expect(
        runtime.resolveProviderDeprecatedAuthProfileIds({
          provider: DEMO_PROVIDER_ID,
          workspaceDir: loaded ? "/tmp/workspace" : undefined,
        }),
      ).toEqual(loaded ? ["demo:retired"] : []);
      expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      providerId: "ollama",
      requestedProvider: "ollama-spark",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      aliases: [],
      loaded: true,
      matches: true,
    },
    {
      providerId: "qwen",
      requestedProvider: "modelstudio",
      api: "dashscope",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      aliases: ["modelstudio"],
      loaded: false,
      matches: false,
    },
  ])("selects $requestedProvider hooks by its configured API owner $api", (row) => {
    const provider = createDemoProvider({
      id: row.providerId,
      label: row.providerId,
      aliases: row.aliases,
      createStreamFn: vi.fn(() => vi.fn()),
    });
    if (row.loaded) {
      registerLoadedProviders([provider], "/tmp/workspace");
    } else {
      resolvePluginProvidersMock.mockReturnValue([provider]);
    }

    const plugin = runtime.resolveProviderRuntimePlugin({
      provider: row.requestedProvider,
      ...(row.loaded ? { workspaceDir: "/tmp/workspace" } : {}),
      config: {
        models: {
          providers: {
            [row.requestedProvider]: {
              api: row.api,
              baseUrl: row.baseUrl,
              models: [],
            },
          },
        },
      } as never,
    });

    if (row.matches) {
      expect(plugin?.id).toBe(row.providerId);
      expect(plugin?.pluginId).toBe(row.providerId);
      expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
    } else {
      expect(plugin).toBeUndefined();
      expect(getLastResolvePluginProvidersParams().providerRefs).toEqual([
        row.requestedProvider,
        row.api,
      ]);
    }
  });

  it("installs provider stream hooks into the AI transport host", () => {
    const streamFn = vi.fn();
    const createStreamFn = vi.fn(() => streamFn);
    const provider: ProviderPlugin = createDemoProvider({ createStreamFn });
    registerLoadedProviders([provider], "/tmp/workspace");

    const registeredStream = getAiTransportHost().plugin.resolveProviderStream({
      provider: DEMO_PROVIDER_ID,
      workspaceDir: "/tmp/workspace",
      allowRuntimePluginLoad: false,
      context: createDemoResolvedModelContext({}),
    });
    const context = { messages: [] };
    void registeredStream?.(MODEL, context);
    expect(streamFn).toHaveBeenCalledWith(MODEL, context, undefined);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("does not load runtime plugins for stream hooks when loading is disabled", () => {
    expect(
      runtime.resolveProviderStreamFn({
        provider: DEMO_PROVIDER_ID,
        allowRuntimePluginLoad: false,
        context: createDemoResolvedModelContext({}),
      }),
    ).toBeUndefined();
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("adapts loaded legacy websocket policy without loading runtime plugins", () => {
    const provider: ProviderPlugin = createDemoProvider({
      resolveTransportTurnState: () => ({
        headers: { "x-demo-turn": "turn-1" },
        websocket: { degradeCooldownMs: 5_000 },
      }),
      resolveWebSocketSessionPolicy: () => ({
        headers: { "x-demo-session": "session-1" },
        degradeCooldownMs: 60_000,
      }),
    });
    registerLoadedProviders([provider], "/tmp/workspace");

    expect(
      runtime.resolveProviderTransportTurnStateWithPlugin({
        provider: DEMO_PROVIDER_ID,
        workspaceDir: "/tmp/workspace",
        allowRuntimePluginLoad: false,
        context: createDemoResolvedModelContext({
          sessionId: "session-1",
          turnId: "turn-1",
          attempt: 1,
          transport: "websocket",
        }),
      }),
    ).toEqual({
      headers: { "x-demo-turn": "turn-1" },
      websocket: {
        headers: { "x-demo-session": "session-1" },
        degradeCooldownMs: 5_000,
      },
    });
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("reuses the attempt-prepared provider handle at the model transport boundary", () => {
    const streamFn = vi.fn();
    const createStreamFn = vi.fn(() => streamFn);
    const wrapSimpleCompletionStreamFn = vi.fn<
      NonNullable<ProviderPlugin["wrapSimpleCompletionStreamFn"]>
    >(() => streamFn);
    const resolveTransportTurnState = vi.fn(() => ({
      headers: { "x-demo-turn": "turn-1" },
    }));
    const model = attachModelProviderRuntimePluginHandle(MODEL, {
      provider: DEMO_PROVIDER_ID,
      modelId: MODEL.id,
      workspaceDir: "/tmp/workspace",
      plugin: createDemoProvider({
        resolveTransportTurnState,
        createStreamFn,
        wrapSimpleCompletionStreamFn,
      }),
    });

    expect(
      getAiTransportHost().plugin.resolveTransportTurnState({
        provider: DEMO_PROVIDER_ID,
        modelId: MODEL.id,
        allowRuntimePluginLoad: true,
        context: createDemoRuntimeContext({
          model,
          sessionId: "session-1",
          turnId: "turn-1",
          attempt: 1,
          transport: "stream",
        }),
      }),
    ).toEqual({ headers: { "x-demo-turn": "turn-1" } });
    expect(resolveTransportTurnState).toHaveBeenCalledOnce();
    const registeredStream = getAiTransportHost().plugin.resolveProviderStream({
      provider: DEMO_PROVIDER_ID,
      allowRuntimePluginLoad: true,
      context: createDemoResolvedModelContext({ model }),
    });
    const context = { messages: [] };
    void registeredStream?.(model, context);
    expect(streamFn).toHaveBeenCalledWith(model, context, undefined);
    const simpleStream = getAiTransportHost().plugin.wrapSimpleCompletionStream({
      provider: DEMO_PROVIDER_ID,
      context: createDemoResolvedModelContext({ model, streamFn }),
    });
    for (const reasoning of ["off", "max", undefined] as const) {
      void simpleStream?.(model, context, { reasoning });
      expect(streamFn).toHaveBeenLastCalledWith(model, context, { reasoning });
    }
    expect(createStreamFn).toHaveBeenCalledOnce();
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
    expect(isPluginProvidersLoadInFlightMock).not.toHaveBeenCalled();
  });

  it("honors an explicit transport fallback owner over the model's attached handle", () => {
    const streamFn = vi.fn();
    registerLoadedProviders([
      createDemoProvider({ id: "fallback", label: "Fallback", createStreamFn: () => streamFn }),
    ]);
    const model = attachModelProviderRuntimePluginHandle(MODEL, {
      provider: DEMO_PROVIDER_ID,
      modelId: MODEL.id,
      plugin: createDemoProvider(),
    });
    const registeredStream = getAiTransportHost().plugin.resolveProviderStream({
      provider: "fallback",
      allowRuntimePluginLoad: false,
      context: createDemoResolvedModelContext({ model }),
    });
    const context = { messages: [] };
    void registeredStream?.(model, context);
    expect(streamFn).toHaveBeenCalledWith(model, context, undefined);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("does not load runtime plugins for transport turn-state hooks when loading is disabled", () => {
    expect(
      runtime.resolveProviderTransportTurnStateWithPlugin({
        provider: DEMO_PROVIDER_ID,
        allowRuntimePluginLoad: false,
        context: createDemoResolvedModelContext({
          turnId: "turn-1",
          attempt: 1,
          transport: "stream",
        }),
      }),
    ).toBeUndefined();
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it.each(["config", "default"] as const)(
    "uses refreshed same-id metadata after %s runtime invalidation",
    async (cacheOwner) => {
      const config: OpenClawConfig | undefined = cacheOwner === "config" ? {} : undefined;
      setActivePluginRegistry(
        createEmptyPluginRegistry(),
        "metadata-owner",
        "default",
        "/tmp/work",
      );
      const metadata = (source: string) =>
        createPluginMetadataSnapshot({
          config,
          manifestRegistry: {
            plugins: [
              createPluginManifestRecordFixture({
                id: "same-provider-owner",
                providers: [DEMO_PROVIDER_ID],
                origin: "config",
                rootDir: `/plugins/${source}`,
                source: `/plugins/${source}/index.js`,
                manifestPath: `/plugins/${source}/openclaw.plugin.json`,
              }),
            ],
            diagnostics: [],
          },
        });
      const firstMetadata = metadata("first");
      const currentMetadata = metadata("current");
      const provider = (owner: string) =>
        createDemoProvider({
          label: owner,
          resolveAuthProfileId: (context) => `${owner}/${context.preferredProfileId}`,
        });
      const firstProvider = provider("first");
      const currentProvider = provider("current");
      resolvePluginProvidersMock.mockImplementation((params) =>
        params.pluginMetadataSnapshot === firstMetadata ? [firstProvider] : [currentProvider],
      );
      const context = {
        provider: DEMO_PROVIDER_ID,
        modelId: MODEL.id,
        preferredProfileId: "first-profile",
        profileOrder: [],
        authStore: { version: 1 as const, profiles: {} },
      };
      const first = runtime.resolveProviderRuntimePlugin({
        provider: DEMO_PROVIDER_ID,
        config,
        pluginMetadataSnapshot: firstMetadata,
      });
      expect(first?.resolveAuthProfileId?.(context)).toBe("first/first-profile");
      const { invalidatePluginRuntimeDiscoveryAfterConfigMutation } =
        await import("./registry-refresh.js");
      const warnings: string[] = [];
      await invalidatePluginRuntimeDiscoveryAfterConfigMutation({
        logger: { warn: (message) => warnings.push(message) },
      });
      expect(warnings).toEqual([]);
      const current = runtime.resolveProviderRuntimePlugin({
        provider: DEMO_PROVIDER_ID,
        config,
        pluginMetadataSnapshot: currentMetadata,
      });
      expect(
        current?.resolveAuthProfileId?.({ ...context, preferredProfileId: "current-profile" }),
      ).toBe("current/current-profile");
      // The already-prepared handle owns its selected plugin, while credential inputs stay per-call.
      expect(
        runtime.resolveProviderAuthProfileId({
          provider: DEMO_PROVIDER_ID,
          runtimeHandle: { provider: DEMO_PROVIDER_ID, plugin: first },
          context: { ...context, preferredProfileId: "current-profile" },
        }),
      ).toBe("first/current-profile");
    },
  );

  it.each([
    { scope: "matching", providerRefs: ["demo"] },
    { scope: "filtered", providerRefs: ["demo"] },
    { scope: "missing-owner", providerRefs: ["demo"] },
    { scope: "matching", providerRefs: ["unregistered", "demo"] },
    { scope: "matching", providerRefs: ["demo-alias"] },
  ])(
    "uses the correct hook owner with a $scope request registry for $providerRefs",
    ({ scope, providerRefs }) => {
      const active = createEmptyPluginRegistry();
      const scoped = createEmptyPluginRegistry();
      for (const [registry, label] of [
        [active, "active"],
        [scoped, "scoped"],
      ] as const) {
        registry.plugins.push({
          id: "demo-plugin",
          status: scope === "missing-owner" && registry === scoped ? "disabled" : "loaded",
        } as never);
        registry.providers.push({
          pluginId: "demo-plugin",
          source: "demo/index.js",
          provider: {
            id: scope === "filtered" && registry === scoped ? "other" : "demo",
            aliases: ["demo-alias"],
            label,
            auth: [],
          },
        });
      }
      setPluginRuntimeLoadContext(scoped, {
        rawConfig: {},
        config: {},
        activationSourceConfig: {},
        autoEnabledReasons: {},
        workspaceDir: "/tmp/work",
        env: process.env,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });
      setActivePluginRegistry(active, "active", "default", "/tmp/work");
      const plugins = withPluginRuntimeRegistryScope(scoped, () =>
        resolveProviderPluginsForHooks({
          onlyPluginIds: ["demo-plugin"],
          providerRefs,
        }),
      );
      expect(plugins.map((plugin) => plugin.label)).toEqual([
        scope === "matching" ? "scoped" : "active",
      ]);
      expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
    },
  );

  it.each([{ onlyPluginIds: [] }, { onlyPluginIds: [" demo-plugin "] }])(
    "keeps the raw loaded owner scope $onlyPluginIds",
    ({ onlyPluginIds }) => {
      const registry = createEmptyPluginRegistry();
      registry.plugins.push({ id: "demo-plugin", status: "loaded" } as never);
      registry.providers.push({
        pluginId: "demo-plugin",
        source: "demo/index.js",
        provider: createDemoProvider({}),
      });
      setActivePluginRegistry(registry, "active", "default", "/tmp/work");
      expect(resolveLoadedProviderPluginsForHooks({ onlyPluginIds })).toBeUndefined();
      expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
    },
  );

  it("does not cache provider-scoped misses while runtime provider loading is in flight", () => {
    const provider = createDemoProvider();
    let providerScopedLoadInFlight = true;
    isPluginProvidersLoadInFlightMock.mockImplementation(
      (params) =>
        Boolean(params.providerRefs?.includes(DEMO_PROVIDER_ID)) && providerScopedLoadInFlight,
    );
    resolvePluginProvidersMock.mockImplementation((params) =>
      providerScopedLoadInFlight && params.providerRefs?.includes(DEMO_PROVIDER_ID)
        ? []
        : [provider],
    );

    expect(runtime.resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID })).toBeUndefined();
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();

    providerScopedLoadInFlight = false;
    expect(runtime.resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID })).toMatchObject(
      provider,
    );
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse auto-enabled runtime providers for synthetic auth fallback", () => {
    const runtimeProvider: ProviderPlugin = createDemoProvider({
      resolveSyntheticAuth: () => ({
        apiKey: "default-runtime-token",
        source: "default runtime",
        mode: "api-key" as const,
      }),
    });
    resolvePluginProvidersMock.mockImplementation((params) =>
      params.applyAutoEnable === false ? [] : [runtimeProvider],
    );

    expect(runtime.resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID })).toMatchObject(
      runtimeProvider,
    );

    expect(
      runtime.resolveProviderSyntheticAuthWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoProviderContext({
          providerConfig: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        }),
      }),
    ).toBeUndefined();
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(3);
  });

  it("skips provider runtime loading when no plugin declares external auth hooks", () => {
    expect(
      runtime.resolveExternalAuthProfilesWithPlugins({
        env: process.env,
        context: {
          env: process.env,
          store: { version: 1, profiles: {} },
        },
      }),
    ).toStrictEqual([]);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("resolves declared external auth plugins with different provider ids", () => {
    resolveExternalAuthProfileProviderPluginIdsMock.mockReturnValue(["demo-plugin"]);
    resolvePluginProvidersMock.mockReturnValue([
      createDemoProvider({
        id: "demo-provider",
        pluginId: "demo-plugin",
        label: "Demo Provider",
        resolveExternalAuthProfiles: () => [
          {
            profileId: "demo-provider:external",
            credential: {
              type: "oauth",
              provider: "demo-provider",
              access: "access",
              refresh: "refresh",
              expires: Date.now() + 60_000,
            },
          },
        ],
      }),
    ]);

    const [profile] = runtime.resolveExternalAuthProfilesWithPlugins({
      env: process.env,
      context: {
        env: process.env,
        store: { version: 1, profiles: {} },
      },
    });
    expect(profile?.profileId).toBe("demo-provider:external");
  });

  it("resolves catalog hook provider loads when only non-plugin config changes", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["demo"]);
    resolvePluginProvidersMock.mockReturnValue([
      createDemoProvider({
        augmentModelCatalog: () => [{ provider: "demo", id: "demo-model", name: "Demo Model" }],
      }),
    ]);
    const metadataSnapshot = {
      ...createPluginMetadataSnapshotFixture(),
      workspaceDir: "/tmp/snapshot-workspace",
    };
    for (const model of ["openai/gpt-5.4", "anthropic/claude-sonnet-4-5"]) {
      const config: OpenClawConfig = {
        plugins: { entries: { demo: { enabled: true } } },
        agents: { defaults: { model } },
      };
      expect(
        await runtime.augmentModelCatalogWithProviderPlugins({
          config,
          env: process.env,
          metadataSnapshot,
          context: { config, env: process.env, entries: [] },
        }),
      ).toEqual([{ provider: "demo", id: "demo-model", name: "Demo Model" }]);
    }

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
    expect(resolveCatalogHookProviderPluginIdsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadataSnapshot,
        workspaceDir: "/tmp/snapshot-workspace",
      }),
    );
    expect(resolvePluginProvidersMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pluginMetadataSnapshot: metadataSnapshot,
        workspaceDir: "/tmp/snapshot-workspace",
      }),
    );
  });

  it("unwraps secret sentinels only after finding the provider auth hook", async () => {
    const { mintSecretSentinel } = await import("../secrets/sentinel.js");
    const sourceToken = "provider-source-token";
    const sourceSentinel = mintSecretSentinel(sourceToken, { label: "provider-runtime-test" });
    const prepareRuntimeAuth = vi.fn(async () => ({ apiKey: "runtime-token" }));
    resolvePluginProvidersMock.mockReturnValue([createDemoProvider({ prepareRuntimeAuth })]);

    await runtime.prepareProviderRuntimeAuth({
      provider: DEMO_PROVIDER_ID,
      context: createDemoResolvedModelContext({
        env: process.env,
        apiKey: sourceSentinel,
        authMode: "token",
      }),
    });

    expect(prepareRuntimeAuth).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: sourceToken }),
    );

    resolvePluginProvidersMock.mockReturnValue([]);
    await expect(
      runtime.prepareProviderRuntimeAuth({
        provider: "provider-without-hook",
        context: {
          env: process.env,
          provider: "provider-without-hook",
          modelId: MODEL.id,
          model: { ...MODEL, provider: "provider-without-hook" },
          apiKey: "oc-sent-v2.unknown.end",
          authMode: "token",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("exposes provider-owned transport extra params", () => {
    const extraParamsForTransport = vi.fn((_ctx) => ({
      patch: {
        providerTransportPatch: true,
      },
    }));
    resolvePluginProvidersMock.mockReturnValue([createDemoProvider({ extraParamsForTransport })]);

    expect(
      resolvePreparedExtraParams({
        cfg: undefined,
        provider: DEMO_PROVIDER_ID,
        modelId: MODEL.id,
        model: MODEL,
        extraParamsOverride: { transport: "websocket" },
      }),
    ).toEqual({
      transport: "websocket",
      providerTransportPatch: true,
    });
  });

  it("exposes provider-owned auth profile and fallback route seams", () => {
    const resolveAuthProfileId = vi.fn(() => "profile-b");
    const followupFallbackRoute = vi.fn(() => ({
      route: "dispatcher" as const,
      reason: "origin unavailable",
    }));
    resolvePluginProvidersMock.mockReturnValue([
      createDemoProvider({ resolveAuthProfileId, followupFallbackRoute }),
    ]);

    expect(
      runtime.resolveProviderAuthProfileId({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          profileOrder: ["profile-a", "profile-b"],
          authStore: { version: 1, profiles: {}, order: {} },
        }),
      }),
    ).toBe("profile-b");
    expect(
      runtime.resolveProviderFollowupFallbackRoute({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          payload: { text: "hello" },
          originRoutable: false,
          dispatcherAvailable: true,
        }),
      }),
    ).toEqual({
      route: "dispatcher",
      reason: "origin unavailable",
    });
  });

  it("lets provider-owned prompt overlays compose after the built-in GPT-5 overlay", () => {
    const resolvePromptOverlay = vi.fn((ctx) => ({
      stablePrefix: "provider overlay",
      sectionOverrides: {
        execution_bias: ctx.baseOverlay?.stablePrefix ? "saw built-in overlay" : "missing",
      },
    }));
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "openrouter",
        label: "OpenRouter",
        auth: [],
        resolvePromptOverlay,
      } satisfies ProviderPlugin,
    ]);

    const contribution = runtime.resolveProviderSystemPromptContribution({
      provider: "openrouter",
      context: {
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
        promptMode: "full",
      } as never,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.stablePrefix).toContain("provider overlay");
    expect(contribution?.sectionOverrides?.execution_bias).toBe("saw built-in overlay");
  });

  it.each([
    ["openrouter", "openai/gpt-5.4", false],
    ["openai", "gpt-5.4", true],
    ["azure-openai-responses", "gpt-5.4", true],
  ] as const)("scopes OpenAI personality fallback to %s", (provider, modelId, usesFallback) => {
    const contribution = runtime.resolveProviderSystemPromptContribution({
      provider,
      config: { plugins: { entries: { openai: { config: { personality: "off" } } } } },
      context: { provider, modelId, promptMode: "full" },
    });
    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    if (usesFallback) {
      expect(contribution?.sectionOverrides).toStrictEqual({});
    } else {
      expect(contribution?.sectionOverrides?.interaction_style).toContain(
        "Live chat: short, natural, human.",
      );
    }
  });

  it("does not scan provider plugins after bundled policy surface handles config", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [],
    };
    const normalizeConfig = vi.fn(() => providerConfig);
    resolveBundledProviderPolicySurfaceMock.mockReturnValue({
      normalizeConfig,
    });

    expect(
      runtime.normalizeProviderConfigWithPlugin({
        provider: "openai",
        context: {
          provider: "openai",
          providerConfig,
        },
      }),
    ).toBeUndefined();

    expect(normalizeConfig).toHaveBeenCalledTimes(1);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("forwards prepared manifest metadata to bundled config policy resolution", () => {
    const manifestRegistry = { plugins: [] };
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [],
    };
    resolveBundledProviderPolicySurfaceMock.mockReturnValue({
      normalizeConfig: ({ providerConfig: candidateConfig }) => ({
        ...candidateConfig,
        baseUrl: "https://normalized.example.com/v1",
      }),
      resolveConfigApiKey: () => "EXAMPLE_API_KEY",
    });

    expect(
      runtime.normalizeProviderConfigWithPlugin({
        provider: "example-alias",
        manifestRegistry,
        context: {
          provider: "example-alias",
          providerConfig,
        },
      })?.baseUrl,
    ).toBe("https://normalized.example.com/v1");
    expect(
      runtime.resolveProviderConfigApiKeyWithPlugin({
        provider: "example-alias",
        manifestRegistry,
        context: {
          provider: "example-alias",
          env: {},
        },
      }),
    ).toBe("EXAMPLE_API_KEY");

    expect(resolveBundledProviderPolicySurfaceMock).toHaveBeenNthCalledWith(1, "example-alias", {
      manifestRegistry,
    });
    expect(resolveBundledProviderPolicySurfaceMock).toHaveBeenNthCalledWith(2, "example-alias", {
      manifestRegistry,
    });
  });

  it.each([undefined, "openai"])(
    "does not discover providers while classifying an error for %s",
    (provider) => {
      expect(
        runtime.classifyProviderFailoverSignalWithPlugin({
          provider,
          context: { provider, errorMessage: "bad request" },
        }),
      ).toBeUndefined();
      expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "openai"])(
    "keeps an empty generation authoritative when classifying for %s",
    (provider) => {
      const classifyFailoverReason = vi.fn(() => "billing" as const);
      registerLoadedProviders([
        { id: "openai", label: "OpenAI", auth: [], classifyFailoverReason },
      ]);
      const config = {};
      const metadataSnapshot = createPluginMetadataSnapshot({
        config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      withPluginRuntimeGenerationScope({ metadataSnapshot }, () => {
        expect(
          runtime.classifyProviderFailoverSignalWithPlugin({
            provider,
            context: { provider, errorMessage: "bad request" },
          }),
        ).toBeUndefined();
        expect(resolveProviderPluginsForHooks({})).toEqual([]);
      });
      expect(classifyFailoverReason).not.toHaveBeenCalled();
      expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "openai", "custom-provider"])(
    "reuses active hooks after an empty request scope for %s",
    (provider) => {
      registerLoadedProviders([
        { id: "openai", label: "OpenAI", auth: [], classifyFailoverReason: () => "billing" },
      ]);
      const result = withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
        runtime.classifyProviderFailoverSignalWithPlugin({
          provider,
          context: { provider, errorMessage: "bad request" },
        }),
      );
      expect(result).toBe("billing");
      expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
    },
  );

  it("resolves failover classification through hook-only aliases", () => {
    registerLoadedProviders([
      createDemoProvider({
        id: "openai",
        label: "OpenAI",
        hookAliases: ["azure-openai-responses"],
        matchesContextOverflowError: ({ errorMessage }) =>
          /\bcontent_filter\b.*\btoo long\b/i.test(errorMessage),
        classifyFailoverReason: ({ errorMessage, code, status }) => {
          if (status === 403 && code === "PROVIDER_QUOTA_EXHAUSTED") {
            return "billing";
          }
          return /\bquota exceeded\b/i.test(errorMessage) ? "rate_limit" : undefined;
        },
      }),
    ]);

    expect(
      runtime.classifyProviderFailoverSignalWithPlugin({
        provider: "azure-openai-responses",
        context: {
          provider: "azure-openai-responses",
          errorMessage: "content_filter prompt too long",
        },
      }),
    ).toBe("context_overflow");
    expect(
      runtime.classifyProviderFailoverSignalWithPlugin({
        provider: "azure-openai-responses",
        context: {
          provider: "azure-openai-responses",
          errorMessage: "quota exceeded",
        },
      }),
    ).toBe("rate_limit");
    expect(
      runtime.classifyProviderFailoverSignalWithPlugin({
        provider: "azure-openai-responses",
        context: {
          provider: "azure-openai-responses",
          errorMessage: "Forbidden",
          status: 403,
          code: "PROVIDER_QUOTA_EXHAUSTED",
        },
      }),
    ).toBe("billing");
  });

  it.each([
    { result: "billing", expected: "billing", laterCalls: 0 },
    { result: "unsupported-reason", expected: undefined, laterCalls: 0 },
    { result: {}, expected: undefined, laterCalls: 0 },
    { result: null, expected: "overloaded", laterCalls: 1 },
  ])(
    "normalizes external failover result $result without changing hook precedence",
    ({ result, expected, laterCalls }) => {
      const later = vi.fn(() => "overloaded" as const);
      registerLoadedProviders([
        // External JavaScript plugins are not constrained by the TypeScript return type.
        {
          id: "first",
          label: "First",
          auth: [],
          classifyFailoverReason: () => result,
        } as ProviderPlugin,
        { id: "second", label: "Second", auth: [], classifyFailoverReason: later },
      ]);
      expect(
        runtime.classifyProviderFailoverSignalWithPlugin({
          context: { errorMessage: "fixture failure" },
        }),
      ).toBe(expected);
      expect(later).toHaveBeenCalledTimes(laterCalls);
    },
  );

  it("does not broad-scan failover hooks for unresolved providers with structured descriptors", () => {
    const classifyFailoverReason = vi.fn(() => "overloaded" as const);
    registerLoadedProviders([
      {
        id: "mantle",
        label: "Mantle",
        auth: [],
        classifyFailoverReason,
      },
    ]);

    expect(
      runtime.classifyProviderFailoverSignalWithPlugin({
        provider: "my-openai-compatible",
        context: {
          provider: "my-openai-compatible",
          status: 403,
          errorMessage: "service unavailable",
        },
      }),
    ).toBeUndefined();
    expect(classifyFailoverReason).not.toHaveBeenCalled();
  });

  it.each([false, true])("honors simple-completion wrapper opt-in %s", (optedIn) => {
    const wrappedStreamFn = vi.fn();
    const wrapStreamFn = vi.fn(() => wrappedStreamFn);
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "moonshot",
        label: "Moonshot",
        auth: [],
        wrapStreamFn,
        ...(optedIn ? { wrapSimpleCompletionStreamFn: () => wrappedStreamFn } : {}),
      },
    ]);

    const stream = runtime.wrapProviderSimpleCompletionStreamFn({
      provider: "moonshot",
      context: createDemoResolvedModelContext({
        provider: "moonshot",
        streamFn: wrappedStreamFn,
      }),
    });
    if (optedIn) {
      void stream?.(MODEL, { messages: [] }, { reasoning: "off" });
      expect(wrappedStreamFn).toHaveBeenCalledExactlyOnceWith(
        MODEL,
        { messages: [] },
        { reasoning: "off" },
      );
    } else {
      expect(stream).toBeUndefined();
    }
    expect(wrapStreamFn).not.toHaveBeenCalled();
  });

  it("does not run broad provider-hook scans for auth profile selection", () => {
    allowOnlyMockOpenAiProviderLoad();

    expect(
      runtime.resolveProviderAuthProfileId({
        provider: "mock-openai",
        context: createDemoRuntimeContext({
          provider: "mock-openai",
          modelId: "gpt-5.5",
          profileOrder: [],
          authStore: { version: 1, profiles: {}, order: {} },
        }),
      }),
    ).toBeUndefined();
    expect(resolvePluginProvidersMock).toHaveBeenCalledOnce();
  });

  it("does not run broad provider-hook scans for transport extra params", () => {
    allowOnlyMockOpenAiProviderLoad();

    expect(
      resolvePreparedExtraParams({
        cfg: undefined,
        provider: "mock-openai",
        modelId: "gpt-5.5",
      }),
    ).toEqual({});
    expect(resolvePluginProvidersMock).toHaveBeenCalledOnce();
  });

  it("scopes resolved transport hook lookup to explicit custom provider models", () => {
    const openaiPlugin: ProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      auth: [],
      normalizeTransport: () => ({ api: "openai-responses" }),
    };
    resolvePluginProvidersMock.mockReturnValue([openaiPlugin]);

    expect(
      runtime.applyProviderResolvedTransportWithPlugin({
        provider: "tui-pty-mock",
        config: {
          models: {
            providers: {
              "tui-pty-mock": {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:64087/v1",
                models: [{ id: "gpt-5.5" }],
              },
            },
          },
        } as never,
        context: createDemoResolvedModelContext({
          provider: "tui-pty-mock",
          modelId: "gpt-5.5",
          model: {
            ...MODEL,
            provider: "tui-pty-mock",
            id: "gpt-5.5",
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:64087/v1",
          },
        }),
      }),
    ).toBeUndefined();
    expect(getLastResolvePluginProvidersParams().providerRefs).toEqual(["tui-pty-mock"]);
    expect(getLastResolvePluginProvidersParams().modelRefs).toEqual(["tui-pty-mock/gpt-5.5"]);
  });

  it("invalidates cached runtime providers when config mutates in place", () => {
    const config = {
      plugins: {
        entries: {
          demo: { enabled: false },
        },
      },
    };
    resolvePluginProvidersMock.mockImplementation((params) => {
      const runtimeConfig = params?.config as typeof config | undefined;
      return runtimeConfig?.plugins?.entries?.demo?.enabled === true ? [createDemoProvider()] : [];
    });
    expect(
      runtime.resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID, config }),
    ).toBeUndefined();
    config.plugins.entries.demo.enabled = true;
    expect(runtime.resolveProviderRuntimePlugin({ provider: DEMO_PROVIDER_ID, config })?.id).toBe(
      DEMO_PROVIDER_ID,
    );
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("dispatches model, replay, schema, and usage hooks through the matched owner", async () => {
    resolvePluginProvidersMock.mockReturnValue([
      createDemoProvider({
        resolveDynamicModel: () => MODEL,
        prepareDynamicModel: async () => MODEL,
        sanitizeReplayHistoryAsync: async ({ messages }) => [...messages, DEMO_SANITIZED_MESSAGE],
        validateReplayTurns: async ({ messages }) => messages,
        normalizeToolSchemas: ({ tools }) => tools,
        inspectToolSchemas: () => [],
        resolveReasoningOutputMode: () => "tagged",
        normalizeResolvedModel: ({ model }) => ({ ...model, api: "openai-chatgpt-responses" }),
        resolveUsageAuth: async () => ({ token: "usage-token" }),
        fetchUsageSnapshot: async () => ({ provider: "zai", displayName: "Demo", windows: [] }),
        shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) => resolvedApiKey === "demo-local",
      }),
    ]);
    const model = {
      provider: DEMO_PROVIDER_ID,
      context: createDemoResolvedModelContext({ modelApi: MODEL.api }),
    };
    const dynamic = {
      provider: DEMO_PROVIDER_ID,
      context: createDemoRuntimeContext({ modelRegistry: EMPTY_MODEL_REGISTRY }),
    };
    const replay = {
      provider: DEMO_PROVIDER_ID,
      context: createDemoResolvedModelContext({
        modelApi: MODEL.api,
        sessionId: "session-1",
        messages: DEMO_REPLAY_MESSAGES,
      }),
    };
    const schema = {
      provider: DEMO_PROVIDER_ID,
      context: createDemoResolvedModelContext({ modelApi: MODEL.api, tools: [DEMO_TOOL] }),
    };
    expect(runtime.runProviderDynamicModel(dynamic)).toEqual(MODEL);
    expect(await runtime.prepareProviderDynamicModel(dynamic)).toEqual(MODEL);
    expect(runtime.resolveProviderReasoningOutputModeWithPlugin(model)).toBe("tagged");
    expect(await runtime.sanitizeProviderReplayHistoryWithPluginAsync(replay)).toEqual([
      ...DEMO_REPLAY_MESSAGES,
      DEMO_SANITIZED_MESSAGE,
    ]);
    expect(await runtime.validateProviderReplayTurnsWithPlugin(replay)).toEqual(
      DEMO_REPLAY_MESSAGES,
    );
    expect(runtime.normalizeProviderToolSchemasWithPlugin(schema)).toEqual([DEMO_TOOL]);
    expect(runtime.inspectProviderToolSchemasWithPlugin(schema)).toStrictEqual([]);
    expect(runtime.normalizeProviderResolvedModelWithPlugin(model)).toEqual({
      ...MODEL,
      api: "openai-chatgpt-responses",
    });
    expect(
      await runtime.resolveProviderUsageAuthWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoProviderContext({
          config: {},
          env: process.env,
          resolveApiKeyFromConfigAndStore: () => "source-token",
          resolveOAuthToken: async () => null,
        }),
      }),
    ).toEqual({ token: "usage-token" });
    expect(
      await runtime.resolveProviderUsageSnapshotWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoProviderContext({
          config: {},
          env: process.env,
          token: "usage-token",
          timeoutMs: 5_000,
          fetchFn: vi.fn(),
        }),
      }),
    ).toEqual({ provider: "zai", displayName: "Demo", windows: [] });
    expect(
      runtime.shouldDeferProviderSyntheticProfileAuthWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoProviderContext({ resolvedApiKey: "demo-local" }),
      }),
    ).toBe(true);
  });

  it.each([
    { change: "API", normalized: { api: "openai-responses" as const } },
    { change: "base URL", normalized: { baseUrl: "https://normalized.example/v1" } },
  ])("applies foreign transport $change normalization for custom hosts", ({ normalized }) => {
    const model = {
      ...MODEL,
      provider: "custom-openai",
      id: "gpt-5.4",
      api: "openai-completions" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    resolvePluginProvidersMock.mockImplementation((params) => {
      const plugins = [
        createDemoProvider({
          id: "openai",
          normalizeTransport: ({ provider, api, baseUrl }) =>
            provider === model.provider && api === model.api && baseUrl === model.baseUrl
              ? normalized
              : undefined,
        }),
      ];
      return params.onlyPluginIds?.length
        ? plugins.filter((plugin) => params.onlyPluginIds?.includes(plugin.id))
        : plugins;
    });
    expect(
      runtime.applyProviderResolvedTransportWithPlugin({
        provider: model.provider,
        context: createDemoResolvedModelContext({
          provider: model.provider,
          modelId: model.id,
          model,
        }),
      }),
    ).toEqual({ ...model, ...normalized });
  });

  it("does not reuse provider hook results during a nested provider load", () => {
    const cachedModel: ProviderRuntimeModel = {
      ...MODEL,
      baseUrl: "https://cached.example.com",
    };
    let providerLoadInFlight = false;
    isPluginProvidersLoadInFlightMock.mockImplementation(() => providerLoadInFlight);
    resolvePluginProvidersMock.mockImplementation((params) => {
      const providerRef = params?.providerRefs?.[0];
      if (providerRef === "cached-provider") {
        return [
          {
            id: "cached-provider",
            label: "Cached Provider",
            auth: [],
            resolveDynamicModel: () => cachedModel,
          },
        ];
      }
      providerLoadInFlight = true;
      try {
        const reentrantResult = runtime.runProviderDynamicModel({
          provider: "cached-provider",
          context: createDemoRuntimeContext({
            provider: "cached-provider",
            modelRegistry: EMPTY_MODEL_REGISTRY,
          }),
        });
        expect(reentrantResult).toBeUndefined();
        return [];
      } finally {
        providerLoadInFlight = false;
      }
    });

    expect(
      runtime.runProviderDynamicModel({
        provider: "cached-provider",
        context: createDemoRuntimeContext({
          provider: "cached-provider",
          modelRegistry: EMPTY_MODEL_REGISTRY,
        }),
      }),
    ).toBe(cachedModel);

    expect(
      runtime.runProviderDynamicModel({
        provider: "outer-provider",
        context: createDemoRuntimeContext({
          provider: "outer-provider",
          modelRegistry: EMPTY_MODEL_REGISTRY,
        }),
      }),
    ).toBeUndefined();

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
