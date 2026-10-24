import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import type { ProviderExternalAuthProfile } from "./provider-external-auth.types.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import {
  createProviderRuntimeLogger,
  DEMO_SANITIZED_MESSAGE,
  DEMO_TOOL,
  expectAugmentedCodexCatalog,
  expectCodexMissingAuthHint,
  PROVIDER_RUNTIME_TEST_MODEL as MODEL,
} from "./provider-runtime.test-support.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { setPluginRuntimeLoadContext } from "./runtime/load-context.js";
import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderPlugin,
  ProviderSanitizeReplayHistoryContextV2,
  ProviderValidateReplayTurnsContext,
} from "./types.js";

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

const resolvePluginProvidersMock = vi.fn<ResolvePluginProviders>(
  (_params) => [] as ProviderPlugin[],
);
const isPluginProvidersLoadInFlightMock = vi.fn<IsPluginProvidersLoadInFlight>((_params) => false);
const resolveCatalogHookProviderPluginIdsMock = vi.fn<ResolveCatalogHookProviderPluginIds>(
  (_params) => [] as string[],
);
const resolveUsageHookProviderPluginContractsMock = vi.fn<ResolveUsageHookProviderPluginContracts>(
  (_params) => [],
);
const resolveExternalAuthProfileProviderPluginIdsMock =
  vi.fn<ResolveExternalAuthProfileProviderPluginIds>((_params) => [] as string[]);
const resolveOwningPluginIdsForProviderMock = vi.fn<ResolveOwningPluginIdsForProvider>(
  (_params) => undefined,
);
const resolveBundledProviderPolicySurfaceMock = vi.fn<ResolveBundledProviderPolicySurface>(
  (_providerId) => null,
);
const resolveProviderPolicySurfaceMock = vi.fn<ResolveProviderPolicySurface>((_providerId) => null);
const providerRuntimeWarnMock = vi.fn();

let runtime: typeof import("./provider-runtime.js");
let getAiTransportHost: typeof import("@openclaw/ai").getAiTransportHost;
let attachModelProviderRuntimePluginHandle: typeof import("./provider-hook-runtime.js").attachModelProviderRuntimePluginHandle;
let resolveProviderPluginsForHooks: typeof import("./provider-hook-runtime.js").resolveProviderPluginsForHooks;
let resolveLoadedProviderPluginsForHooks: typeof import("./provider-hook-runtime.js").resolveLoadedProviderPluginsForHooks;
let resolvePreparedExtraParams: typeof import("../agents/embedded-agent-runner/extra-params.js").resolvePreparedExtraParams;
let applyExtraParamsToAgent: typeof import("../agents/embedded-agent-runner/extra-params.js").applyExtraParamsToAgent;
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

function firstMockArg(mock: { mock: { calls: unknown[][] } }): unknown {
  return mock.mock.calls[0]?.[0];
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

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
      resolveCatalogHookProviderPluginIds: (params: unknown) =>
        resolveCatalogHookProviderPluginIdsMock(params as never),
      resolveUsageHookProviderPluginContracts: (params: unknown) =>
        resolveUsageHookProviderPluginContractsMock(params as never),
      resolveExternalAuthProfileProviderPluginIds: (params: unknown) =>
        resolveExternalAuthProfileProviderPluginIdsMock(params as never),
      resolveOwningPluginIdsForProvider: (params: unknown) =>
        resolveOwningPluginIdsForProviderMock(params as never),
      resolveOwningPluginIdsForProviderRef: (params: unknown) =>
        resolveOwningPluginIdsForProviderMock(params as never),
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
    ({ resolvePreparedExtraParams, applyExtraParamsToAgent } =
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
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
    isPluginProvidersLoadInFlightMock.mockReset();
    isPluginProvidersLoadInFlightMock.mockReturnValue(false);
    resolveCatalogHookProviderPluginIdsMock.mockReset();
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue([]);
    resolveUsageHookProviderPluginContractsMock.mockReset();
    resolveUsageHookProviderPluginContractsMock.mockReturnValue([]);
    resolveExternalAuthProfileProviderPluginIdsMock.mockReset();
    resolveExternalAuthProfileProviderPluginIdsMock.mockReturnValue([]);
    resolveOwningPluginIdsForProviderMock.mockReset();
    resolveOwningPluginIdsForProviderMock.mockReturnValue(undefined);
    resolveBundledProviderPolicySurfaceMock.mockReset();
    resolveBundledProviderPolicySurfaceMock.mockReturnValue(null);
    resolveProviderPolicySurfaceMock.mockReset();
    resolveProviderPolicySurfaceMock.mockReturnValue(null);
    providerRuntimeWarnMock.mockReset();
  });

  it("matches providers by alias for runtime hook lookup", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "openrouter",
        label: "OpenRouter",
        aliases: ["Open Router"],
        auth: [],
      },
    ]);

    const plugin = runtime.resolveProviderRuntimePlugin({ provider: "Open Router" });

    expect(plugin?.id).toBe("openrouter");
    expectRecordFields(getLastResolvePluginProvidersParams(), {
      providerRefs: ["Open Router"],
    });
  });

  it.each([true, false])("dispatches session OAuth with owner available=%s", async (available) => {
    const loginOAuth = vi.fn(async () => ({
      access: "login-access",
      refresh: "login-refresh",
      expires: 123,
    }));
    const refreshConfig: OpenClawConfig = {
      models: {
        providers: {
          "plugin-oauth": { baseUrl: "https://caller.example.com/anthropic", models: [] },
        },
      },
    };
    const refreshOAuth = vi.fn<NonNullable<ProviderPlugin["refreshOAuth"]>>(
      async (credential, config) => ({
        ...credential,
        access:
          config?.models?.providers?.["plugin-oauth"]?.baseUrl ===
          "https://caller.example.com/anthropic"
            ? "refreshed-access"
            : "wrong-region-access",
      }),
    );
    if (!available) {
      resolveOwningPluginIdsForProviderMock.mockReturnValue(["plugin-oauth"]);
    }
    resolvePluginProvidersMock.mockReturnValue(
      available
        ? [
            {
              id: "plugin-oauth",
              label: "Plugin OAuth",
              auth: [],
              loginOAuth,
              refreshOAuth,
              formatApiKey: (credential) =>
                credential.type === "oauth" ? `formatted:${credential.access}` : "",
            },
          ]
        : [],
    );

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
    expect(loginOAuth).toHaveBeenCalledTimes(available ? 1 : 0);
    expect(refreshOAuth).toHaveBeenCalledTimes(available ? 1 : 0);
  });

  it("auto-discovers only usage providers declared by their owning plugin", () => {
    resolveUsageHookProviderPluginContractsMock.mockReturnValue([
      { pluginId: "multi-provider", providerIds: ["declared"] },
    ]);
    const usageHooks = {
      auth: [],
      resolveUsageAuth: vi.fn(async () => ({ token: "usage-token" })),
      fetchUsageSnapshot: vi.fn(async () => ({
        provider: "declared",
        displayName: "Declared",
        windows: [],
      })),
    };
    resolvePluginProvidersMock.mockReturnValue([
      { ...usageHooks, id: "declared", label: "Declared" },
      { ...usageHooks, id: "undeclared", label: "Undeclared" },
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
    expect(resolveSystemPromptContribution).toHaveBeenCalledOnce();
    expectRecordFields(getLastResolvePluginProvidersParams(), {
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
        context: { provider: DEMO_PROVIDER_ID, status: 403, errorMessage: "fixture refusal" },
      }),
    ).toBe("billing");
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("does not activate provider runtime to inspect retired auth profiles", () => {
    resolvePluginProvidersMock.mockReturnValue([
      createDemoProvider({ deprecatedProfileIds: ["demo:retired"] }),
    ]);

    expect(runtime.resolveProviderDeprecatedAuthProfileIds({ provider: DEMO_PROVIDER_ID })).toEqual(
      [],
    );
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("honors retired auth profiles declared by an active provider", () => {
    const provider: ProviderPlugin = createDemoProvider({ deprecatedProfileIds: ["demo:retired"] });
    registerLoadedProviders([provider], "/tmp/workspace");

    expect(
      runtime.resolveProviderDeprecatedAuthProfileIds({
        provider: DEMO_PROVIDER_ID,
        workspaceDir: "/tmp/workspace",
      }),
    ).toEqual(["demo:retired"]);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

  it("uses the prepared run registry without repeating provider discovery", () => {
    const provider = createDemoProvider({
      pluginId: "embedded-owner",
      label: "Prepared demo",
      classifyFailoverReason: () => "overloaded",
    });
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "registered-owner",
      provider,
      source: "test",
    });
    setPluginRuntimeLoadContext(registry, {
      rawConfig: {},
      config: {},
      activationSourceConfig: {},
      autoEnabledReasons: {},
      workspaceDir: "/tmp/prepared-workspace",
      env: process.env,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const resolved = withPluginRuntimeRegistryScope(registry, () =>
      runtime.resolveProviderRuntimePlugin({
        provider: DEMO_PROVIDER_ID,
        workspaceDir: "/tmp/prepared-workspace",
      }),
    );

    expect(
      withPluginRuntimeRegistryScope(registry, () =>
        runtime.classifyProviderFailoverSignalWithPlugin({
          provider: DEMO_PROVIDER_ID,
          workspaceDir: "/tmp/prepared-workspace",
          context: { provider: DEMO_PROVIDER_ID, status: 403, errorMessage: "fixture refusal" },
        }),
      ),
    ).toBe("overloaded");
    expect(resolved?.id).toBe(DEMO_PROVIDER_ID);
    expect(resolved?.pluginId).toBe("registered-owner");
    expect(resolved).not.toBe(provider);
    expect(resolved?.auth).toBe(provider.auth);
    expect(resolved?.classifyFailoverReason).toBe(provider.classifyFailoverReason);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

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
    expect(createStreamFn).toHaveBeenCalledOnce();
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
    const resolveTransportTurnState = vi.fn(() => ({
      headers: { "x-demo-turn": "turn-1" },
      websocket: { degradeCooldownMs: 5_000 },
    }));
    const resolveWebSocketSessionPolicy = vi.fn(() => ({
      headers: { "x-demo-session": "session-1" },
      degradeCooldownMs: 60_000,
    }));
    const provider: ProviderPlugin = createDemoProvider({
      resolveTransportTurnState,
      resolveWebSocketSessionPolicy,
    });
    registerLoadedProviders([provider], "/tmp/workspace");

    expect(
      runtime.resolveProviderTransportTurnStateWithPlugin({
        provider: DEMO_PROVIDER_ID,
        workspaceDir: "/tmp/workspace",
        allowRuntimePluginLoad: false,
        context: {
          provider: DEMO_PROVIDER_ID,
          modelId: MODEL.id,
          model: MODEL,
          sessionId: "session-1",
          turnId: "turn-1",
          attempt: 1,
          transport: "websocket",
        },
      }),
    ).toEqual({
      headers: { "x-demo-turn": "turn-1" },
      websocket: {
        headers: { "x-demo-session": "session-1" },
        degradeCooldownMs: 5_000,
      },
    });
    expect(resolveTransportTurnState).toHaveBeenCalledOnce();
    expect(resolveWebSocketSessionPolicy).toHaveBeenCalledOnce();
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
        context: {
          provider: DEMO_PROVIDER_ID,
          modelId: MODEL.id,
          model,
          sessionId: "session-1",
          turnId: "turn-1",
          attempt: 1,
          transport: "stream",
        },
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
    expect(wrapSimpleCompletionStreamFn).toHaveBeenCalledOnce();
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
        context: {
          provider: DEMO_PROVIDER_ID,
          modelId: MODEL.id,
          model: MODEL,
          turnId: "turn-1",
          attempt: 1,
          transport: "stream",
        },
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

  it("serves hook plugin lists from the active loaded registry without a scoped load", () => {
    const provider: ProviderPlugin = createDemoProvider({
      pluginId: "embedded-owner",
      aliases: ["demo-alias"],
    });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ id: "demo-plugin", status: "loaded" } as never);
    registry.providers.push(
      { pluginId: "other-plugin", provider, source: "other-plugin/index.js" },
      { pluginId: "demo-plugin", provider, source: "demo-plugin/index.js" },
    );
    setActivePluginRegistry(registry, "workspace-one", "default", "/tmp/work");

    const plugins = resolveProviderPluginsForHooks({
      onlyPluginIds: ["demo-plugin"],
      providerRefs: ["demo-alias"],
    });

    expect(plugins.map((plugin) => plugin.id)).toEqual([DEMO_PROVIDER_ID]);
    expect(plugins[0]?.pluginId).toBe("demo-plugin");
    expect(plugins[0]).not.toBe(provider);
    expect(plugins[0]?.auth).toBe(provider.auth);
    expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
  });

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
        provider: { id: "demo", label: "Demo", auth: [] },
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
        context: {
          provider: DEMO_PROVIDER_ID,
          providerConfig: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
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
      {
        id: "demo",
        label: "Demo",
        auth: [],
        augmentModelCatalog: () => [{ provider: "demo", id: "demo-model", name: "Demo Model" }],
      },
    ]);
    const baseConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const firstConfig = {
      ...baseConfig,
      agents: { defaults: { model: "openai/gpt-5.4" } },
    } as OpenClawConfig;
    const secondConfig = {
      ...baseConfig,
      agents: { defaults: { model: "anthropic/claude-sonnet-4-5" } },
    } as OpenClawConfig;
    const metadataSnapshot = {
      ...createPluginMetadataSnapshotFixture(),
      workspaceDir: "/tmp/snapshot-workspace",
    };

    expect(
      await runtime.augmentModelCatalogWithProviderPlugins({
        config: firstConfig,
        env: process.env,
        metadataSnapshot,
        context: { config: firstConfig, env: process.env, entries: [] },
      }),
    ).toEqual([{ provider: "demo", id: "demo-model", name: "Demo Model" }]);
    expect(
      await runtime.augmentModelCatalogWithProviderPlugins({
        config: secondConfig,
        env: process.env,
        metadataSnapshot,
        context: { config: secondConfig, env: process.env, entries: [] },
      }),
    ).toEqual([{ provider: "demo", id: "demo-model", name: "Demo Model" }]);

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
      context: {
        env: process.env,
        provider: DEMO_PROVIDER_ID,
        modelId: MODEL.id,
        model: MODEL,
        apiKey: sourceSentinel,
        authMode: "token",
      },
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
    expectRecordFields(
      requireRecord(firstMockArg(extraParamsForTransport), "transport params context"),
      {
        provider: DEMO_PROVIDER_ID,
        modelId: MODEL.id,
        model: MODEL,
        transport: "websocket",
      },
    );
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
    const overlayContext = requireRecord(firstMockArg(resolvePromptOverlay), "overlay context");
    expect(overlayContext.provider).toBe("openrouter");
    expect(overlayContext.modelId).toBe("openai/gpt-5.4");
    expect(
      String(requireRecord(overlayContext.baseOverlay, "base overlay").stablePrefix),
    ).toContain("<persona_latch>");
  });

  it("ignores OpenAI plugin personality fallback for non-OpenAI GPT-5 providers", () => {
    const contribution = runtime.resolveProviderSystemPromptContribution({
      provider: "openrouter",
      config: {
        plugins: {
          entries: {
            openai: { config: { personality: "off" } },
          },
        },
      },
      context: {
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
        promptMode: "full",
      } as never,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides?.interaction_style).toContain(
      "Live chat: short, natural, human.",
    );
  });

  it.each(["openai", "azure-openai-responses"])(
    "keeps OpenAI plugin personality fallback for %s GPT-5 providers",
    (provider) => {
      const contribution = runtime.resolveProviderSystemPromptContribution({
        provider,
        config: {
          plugins: {
            entries: {
              openai: { config: { personality: "off" } },
            },
          },
        },
        context: {
          provider,
          modelId: "gpt-5.4",
          promptMode: "full",
        } as never,
      });

      expect(contribution?.stablePrefix).toContain("<persona_latch>");
      expect(contribution?.sectionOverrides).toStrictEqual({});
    },
  );

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

  it("consults loaded failover hooks when a provider owner cannot be resolved", () => {
    const classifyFailoverReason = vi.fn(({ errorMessage }) =>
      /\bconcurrency limit breached\b/i.test(errorMessage) ? "rate_limit" : undefined,
    );
    registerLoadedProviders([
      {
        id: "together",
        label: "Together",
        auth: [],
        classifyFailoverReason,
      },
    ]);

    expect(
      runtime.classifyProviderFailoverSignalWithPlugin({
        provider: "my-together",
        context: {
          provider: "my-together",
          errorMessage: "concurrency limit breached",
        },
      }),
    ).toBe("rate_limit");
    expect(classifyFailoverReason).toHaveBeenCalledWith({
      provider: "my-together",
      errorMessage: "concurrency limit breached",
    });
  });

  it("resolves prepared provider owner hints for custom routes", () => {
    const openrouterPlugin: ProviderPlugin = {
      id: "openrouter",
      label: "OpenRouter",
      auth: [],
    };
    resolvePluginProvidersMock.mockReturnValue([openrouterPlugin]);
    expect(
      runtime.resolveProviderRuntimePlugin({
        provider: "custom-openrouter",
        providerOwner: "openrouter",
        modelId: "anthropic/claude-sonnet-4",
      }),
    ).toMatchObject(openrouterPlugin);
  });

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

  it("does not run broad provider-hook scans for reasoning output mode", () => {
    allowOnlyMockOpenAiProviderLoad();

    expect(
      runtime.resolveProviderReasoningOutputModeWithPlugin({
        provider: "mock-openai",
        context: createDemoResolvedModelContext({
          provider: "mock-openai",
          modelId: "gpt-5.5",
        }),
      }),
    ).toBeUndefined();
    expect(resolvePluginProvidersMock).toHaveBeenCalledOnce();
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

  it("normalizes transport hooks without needing provider ownership", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "google",
        label: "Google",
        auth: [],
        normalizeTransport: ({ api, baseUrl }) =>
          api === "google-generative-ai" && baseUrl === "https://generativelanguage.googleapis.com"
            ? {
                api,
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              }
            : undefined,
      },
    ]);

    expect(
      runtime.normalizeProviderTransportWithPlugin({
        provider: "google-paid",
        context: {
          provider: "google-paid",
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com",
        },
      }),
    ).toEqual({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
  });

  it("does not broad-scan provider hooks for configured core transport providers", () => {
    allowOnlyMockOpenAiProviderLoad();

    expect(
      runtime.normalizeProviderTransportWithPlugin({
        provider: "mock-openai",
        config: {
          models: {
            providers: {
              "mock-openai": {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:64087/v1",
                models: [{ id: "gpt-5.5" }],
              },
            },
          },
        } as never,
        context: {
          provider: "mock-openai",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:64087/v1",
        },
      }),
    ).toBeUndefined();
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
    } as { plugins: { entries: { demo: { enabled: boolean } } } };
    resolvePluginProvidersMock.mockImplementation((params) => {
      const runtimeConfig = params?.config as typeof config | undefined;
      const enabled = runtimeConfig?.plugins?.entries?.demo?.enabled === true;
      return enabled ? [createDemoProvider()] : [];
    });

    expect(
      runtime.resolveProviderRuntimePlugin({
        provider: DEMO_PROVIDER_ID,
        config: config as never,
      }),
    ).toBeUndefined();

    config.plugins.entries.demo.enabled = true;

    expect(
      runtime.resolveProviderRuntimePlugin({
        provider: DEMO_PROVIDER_ID,
        config: config as never,
      })?.id,
    ).toBe(DEMO_PROVIDER_ID);
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });
  it("dispatches runtime hooks for the matched provider", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["openai"]);
    resolveUsageHookProviderPluginContractsMock.mockReturnValue([
      { pluginId: "demo", providerIds: ["demo"] },
    ]);
    resolveExternalAuthProfileProviderPluginIdsMock.mockReturnValue(["demo"]);
    const prepareDynamicModel = vi.fn(async () => MODEL);
    const createStreamFn = vi.fn(() => vi.fn());
    const sanitizeReplayHistoryAsync = vi.fn(
      async ({
        messages,
      }: Pick<ProviderSanitizeReplayHistoryContextV2, "messages">): Promise<AgentMessage[]> => [
        ...messages,
        DEMO_SANITIZED_MESSAGE,
      ],
    );
    const validateReplayTurns = vi.fn(
      async ({
        messages,
      }: Pick<ProviderValidateReplayTurnsContext, "messages">): Promise<AgentMessage[]> => messages,
    );
    const normalizeToolSchemas = vi.fn(
      ({ tools }: Pick<ProviderNormalizeToolSchemasContext, "tools">): AnyAgentTool[] => tools,
    );
    const inspectToolSchemas = vi.fn(() => [] as { toolName: string; violations: string[] }[]);
    const resolveReasoningOutputMode = vi.fn(() => "tagged" as const);
    const resolveSyntheticAuth = vi.fn(() => ({
      apiKey: "demo-local",
      source: "models.providers.demo (synthetic local key)",
      mode: "api-key" as const,
    }));
    const shouldDeferSyntheticProfileAuth = vi.fn(
      ({ resolvedApiKey }: { resolvedApiKey?: string }) => resolvedApiKey === "demo-local",
    );
    const buildUnknownModelHint = vi.fn(
      ({ modelId }: { modelId: string }) => `Use demo setup for ${modelId}`,
    );
    const prepareRuntimeAuth = vi.fn(async () => ({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    }));
    const refreshOAuth = vi.fn<NonNullable<ProviderPlugin["refreshOAuth"]>>(
      async (cred, config) => ({
        ...cred,
        access:
          config?.models?.providers?.[DEMO_PROVIDER_ID]?.baseUrl === "https://caller.example.com/v1"
            ? "request-scoped-access-token"
            : "refreshed-access-token",
      }),
    );
    const resolveUsageAuth = vi.fn(async () => ({
      token: "usage-token",
      accountId: "usage-account",
    }));
    const fetchUsageSnapshot = vi.fn(async () => ({
      provider: "zai" as const,
      displayName: "Demo",
      windows: [{ label: "Day", usedPercent: 25 }],
    }));
    resolvePluginProvidersMock.mockImplementation((_params: unknown) => {
      return [
        createDemoProvider({
          normalizeTransport: ({ api, baseUrl }) => ({
            api,
            baseUrl: baseUrl ? `${baseUrl}/normalized` : undefined,
          }),
          resolveDynamicModel: () => MODEL,
          prepareDynamicModel,
          sanitizeReplayHistoryAsync,
          validateReplayTurns,
          normalizeToolSchemas,
          inspectToolSchemas,
          resolveReasoningOutputMode,
          prepareExtraParams: ({ extraParams }) => ({
            ...extraParams,
            transport: "auto",
          }),
          createStreamFn,
          wrapStreamFn: ({ streamFn, model }) => {
            expect(model).toEqual(MODEL);
            return streamFn;
          },
          resolveSyntheticAuth,
          resolveExternalAuthProfiles: ({ store }): ProviderExternalAuthProfile[] =>
            store.profiles["demo:managed"]
              ? []
              : [
                  {
                    persistence: "runtime-only",
                    profileId: "demo:managed",
                    credential: {
                      type: "oauth",
                      provider: DEMO_PROVIDER_ID,
                      access: "external-access",
                      refresh: "external-refresh",
                      expires: Date.now() + 60_000,
                    },
                  },
                ],
          shouldDeferSyntheticProfileAuth,
          normalizeResolvedModel: ({ model }) => ({
            ...model,
            api: "openai-chatgpt-responses",
          }),
          formatApiKey: (cred) =>
            cred.type === "oauth" ? JSON.stringify({ token: cred.access }) : "",
          refreshOAuth,
          buildAuthDoctorHint: ({ provider, profileId }) =>
            provider === "demo" ? `Repair ${profileId}` : undefined,
          prepareRuntimeAuth,
          resolveUsageAuth,
          fetchUsageSnapshot,
          isCacheTtlEligible: ({ modelId }) => modelId.startsWith("anthropic/"),
          isModernModelRef: ({ modelId }) => modelId.startsWith("gpt-5"),
        }),
        {
          id: "openai",
          label: "OpenAI",
          auth: [],
          augmentModelCatalog: () => [
            { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
            { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
            { provider: "openai", id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
            { provider: "openai", id: "gpt-5.4-nano", name: "gpt-5.4-nano" },
          ],
          buildMissingAuthMessage: () =>
            'No API key found for provider "openai". Use openai/gpt-5.5.',
          buildUnknownModelHint,
        } as ProviderPlugin,
      ];
    });

    expect(runtime.listProviderUsagePluginDescriptors({ env: process.env })).toEqual([
      { provider: "demo", displayName: "demo" },
    ]);

    expect(
      runtime.runProviderDynamicModel({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          modelRegistry: EMPTY_MODEL_REGISTRY,
        }),
      }),
    ).toEqual(MODEL);

    expect(
      runtime.normalizeProviderTransportWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          provider: DEMO_PROVIDER_ID,
          api: "openai-completions",
          baseUrl: "https://demo.example.com",
        },
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://demo.example.com/normalized",
    });

    expect(
      await runtime.prepareProviderDynamicModel({
        provider: DEMO_PROVIDER_ID,
        context: createDemoRuntimeContext({
          modelRegistry: EMPTY_MODEL_REGISTRY,
        }),
      }),
    ).toEqual(MODEL);

    expect(
      runtime.resolveProviderReasoningOutputModeWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
        }),
      }),
    ).toBe("tagged");

    expect(
      resolvePreparedExtraParams({
        cfg: undefined,
        provider: DEMO_PROVIDER_ID,
        modelId: MODEL.id,
        extraParamsOverride: { temperature: 0.3 },
      }),
    ).toEqual({
      temperature: 0.3,
      transport: "auto",
    });

    expect(
      runtime.resolveProviderStreamFn({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({}),
      }),
    ).toBeTypeOf("function");

    const asyncCases = [
      {
        actual: () =>
          runtime.prepareProviderRuntimeAuth({
            provider: DEMO_PROVIDER_ID,
            env: process.env,
            context: createDemoResolvedModelContext({
              env: process.env,
              apiKey: "source-token",
              authMode: "api-key",
            }),
          }),
        expected: {
          apiKey: "runtime-token",
          baseUrl: "https://runtime.example.com/v1",
          expiresAt: 123,
        },
      },
      {
        actual: () =>
          runtime.refreshProviderOAuthCredentialWithPlugin({
            provider: DEMO_PROVIDER_ID,
            config: {
              models: {
                providers: {
                  [DEMO_PROVIDER_ID]: { baseUrl: "https://caller.example.com/v1", models: [] },
                },
              },
            },
            context: createDemoProviderContext({
              type: "oauth",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            }),
          }),
        expected: {
          access: "request-scoped-access-token",
        },
      },
      {
        actual: () =>
          runtime.resolveProviderUsageAuthWithPlugin({
            provider: DEMO_PROVIDER_ID,
            env: process.env,
            context: createDemoProviderContext({
              config: {} as never,
              env: process.env,
              resolveApiKeyFromConfigAndStore: () => "source-token",
              resolveOAuthToken: async () => null,
            }),
          }),
        expected: {
          token: "usage-token",
          accountId: "usage-account",
        },
      },
      {
        actual: () =>
          runtime.resolveProviderUsageSnapshotWithPlugin({
            provider: DEMO_PROVIDER_ID,
            env: process.env,
            context: createDemoProviderContext({
              config: {} as never,
              env: process.env,
              token: "usage-token",
              timeoutMs: 5_000,
              fetchFn: vi.fn() as never,
            }),
          }),
        expected: {
          provider: "zai",
          windows: [{ label: "Day", usedPercent: 25 }],
        },
      },
      {
        actual: () =>
          runtime.sanitizeProviderReplayHistoryWithPluginAsync({
            provider: DEMO_PROVIDER_ID,
            context: createDemoResolvedModelContext({
              modelApi: MODEL.api,
              sessionId: "session-1",
              messages: DEMO_REPLAY_MESSAGES,
            }),
          }),
        expected: {
          1: DEMO_SANITIZED_MESSAGE,
        },
      },
      {
        actual: () =>
          runtime.validateProviderReplayTurnsWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoResolvedModelContext({
              modelApi: MODEL.api,
              sessionId: "session-1",
              messages: DEMO_REPLAY_MESSAGES,
            }),
          }),
        expected: {
          0: DEMO_REPLAY_MESSAGES[0],
        },
      },
    ];
    await Promise.all(
      asyncCases.map(async ({ actual, expected }) => {
        const value = await actual();
        if (!isRecord(value) && !Array.isArray(value)) {
          throw new Error("Expected value to be an object or array");
        }
        const record = value as Record<string, unknown>;
        expectRecordFields(record, expected);
      }),
    );

    const agent = { streamFn: vi.fn() };
    applyExtraParamsToAgent(
      agent,
      undefined,
      DEMO_PROVIDER_ID,
      MODEL.id,
      undefined,
      undefined,
      undefined,
      undefined,
      MODEL,
    );
    expect(agent.streamFn).toBeTypeOf("function");

    expect(
      runtime.normalizeProviderToolSchemasWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
          tools: [DEMO_TOOL],
        }),
      }),
    ).toEqual([DEMO_TOOL]);

    expect(
      runtime.inspectProviderToolSchemasWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
          tools: [DEMO_TOOL],
        }),
      }),
    ).toStrictEqual([]);

    expect(
      runtime.normalizeProviderResolvedModelWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoResolvedModelContext({}),
      }),
    ).toEqual({
      ...MODEL,
      api: "openai-chatgpt-responses",
    });

    expect(
      runtime.formatProviderAuthProfileApiKeyWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: {
          type: "oauth",
          provider: DEMO_PROVIDER_ID,
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    ).toBe('{"token":"oauth-access"}');

    await expect(
      runtime.buildProviderAuthDoctorHintWithPlugin({
        provider: DEMO_PROVIDER_ID,
        context: createDemoProviderContext({
          profileId: "demo:default",
          store: { version: 1, profiles: {} },
        }),
      }),
    ).resolves.toEqual("Repair demo:default");

    [
      {
        actual: () =>
          runtime.resolveProviderCacheTtlEligibility({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "anthropic/claude-sonnet-4-6",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          runtime.resolveProviderModernModelRef({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
            }),
          }),
        expected: true,
      },
      {
        actual: () =>
          runtime.resolveProviderSyntheticAuthWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: createDemoProviderContext({
              providerConfig: {
                api: "openai-completions",
                baseUrl: "http://localhost:11434",
                models: [],
              },
            }),
          }),
        expected: {
          apiKey: "demo-local",
          source: "models.providers.demo (synthetic local key)",
          mode: "api-key",
        },
      },
      {
        actual: () =>
          runtime.shouldDeferProviderSyntheticProfileAuthWithPlugin({
            provider: DEMO_PROVIDER_ID,
            context: {
              provider: DEMO_PROVIDER_ID,
              resolvedApiKey: "demo-local",
            },
          }),
        expected: true,
      },
      {
        actual: () =>
          runtime.buildProviderUnknownModelHintWithPlugin({
            provider: "openai",
            env: process.env,
            context: {
              env: process.env,
              provider: "openai",
              modelId: "gpt-5.4",
            },
          }),
        expected: "Use demo setup for gpt-5.4",
      },
    ].forEach(({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });

    const [externalProfile] = runtime.resolveExternalAuthProfilesWithPlugins({
      env: process.env,
      context: {
        env: process.env,
        store: { version: 1, profiles: {} },
      },
    });
    expectRecordFields(requireRecord(externalProfile, "external auth profile"), {
      persistence: "runtime-only",
      profileId: "demo:managed",
    });
    const credential = requireRecord(externalProfile?.credential, "external auth credential");
    expectRecordFields(credential, {
      type: "oauth",
      provider: DEMO_PROVIDER_ID,
      access: "external-access",
      refresh: "external-refresh",
    });
    expect(typeof credential.expires).toBe("number");

    expectCodexMissingAuthHint(runtime.buildProviderMissingAuthMessageWithPlugin);
    await expectAugmentedCodexCatalog(runtime.augmentModelCatalogWithProviderPlugins);

    for (const mockFn of [
      prepareDynamicModel,
      sanitizeReplayHistoryAsync,
      validateReplayTurns,
      normalizeToolSchemas,
      inspectToolSchemas,
      resolveReasoningOutputMode,
      refreshOAuth,
      resolveSyntheticAuth,
      shouldDeferSyntheticProfileAuth,
      buildUnknownModelHint,
      prepareRuntimeAuth,
      resolveUsageAuth,
      fetchUsageSnapshot,
    ]) {
      expect(mockFn).toHaveBeenCalledTimes(1);
    }
  });

  it("does not treat core transport apis as custom provider plugin owners", () => {
    const openaiPlugin = createDemoProvider({
      id: "openai",
      label: "OpenAI",
      hookAliases: ["openai-responses"],
      createStreamFn: vi.fn(() => vi.fn()),
    });
    resolvePluginProvidersMock.mockReturnValue([openaiPlugin]);

    const plugin = runtime.resolveProviderRuntimePlugin({
      provider: "tui-pty-mock",
      modelId: "gpt-5.5",
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
    });

    expect(plugin).toBeUndefined();
    expect(getLastResolvePluginProvidersParams().providerRefs).toEqual(["tui-pty-mock"]);
    expect(getLastResolvePluginProvidersParams().modelRefs).toEqual(["tui-pty-mock/gpt-5.5"]);
  });

  it("applies foreign transport normalization for custom provider hosts", () => {
    resolvePluginProvidersMock.mockImplementation((params) => {
      const onlyPluginIds = params.onlyPluginIds ?? [];
      const plugins: ProviderPlugin[] = [
        {
          id: "openai",
          label: "OpenAI",
          auth: [],
          normalizeTransport: ({ provider, api, baseUrl }) =>
            provider === "custom-openai" &&
            api === "openai-completions" &&
            baseUrl === "https://api.openai.com/v1"
              ? { api: "openai-responses", baseUrl }
              : undefined,
        },
      ];
      return onlyPluginIds.length > 0
        ? plugins.filter((plugin) => onlyPluginIds.includes(plugin.id))
        : plugins;
    });

    expect(
      runtime.applyProviderResolvedTransportWithPlugin({
        provider: "custom-openai",
        context: createDemoResolvedModelContext({
          provider: "custom-openai",
          modelId: "gpt-5.4",
          model: {
            ...MODEL,
            provider: "custom-openai",
            id: "gpt-5.4",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
          },
        }),
      }),
    ).toEqual({
      ...MODEL,
      provider: "custom-openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
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
