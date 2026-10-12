import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateModelsAuthSetApiKeyResult } from "../../../packages/gateway-protocol/src/index.js";
import type { AuthHealthSummary } from "../../agents/auth-health.js";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
  type RuntimeAuthProfileStore,
} from "../../agents/auth-profiles.js";
import { createAuthProfileStoreFixture } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { UsageSummary } from "../../infra/provider-usage.types.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { NON_ENV_SECRETREF_MARKER } from "../../secrets/provider-credential-values.js";
import { resolveProviderAuthLookupMaps } from "../../secrets/provider-env-vars.js";
import { createChatRunState } from "../server-chat-state.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type BuildAuthHealthSummary = typeof import("../../agents/auth-health.js").buildAuthHealthSummary;

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const emptyUsageSummary = (): UsageSummary => ({ updatedAt: 0, providers: [] });

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  listAgentIds: vi.fn(() => ["main"]),
  resolveAgentDir: vi.fn((_cfg: unknown, agentId: string) =>
    agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`,
  ),
  resolveDefaultAgentId: vi.fn(() => "main"),
  ensureAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(
    (agentDir?: string): AuthProfileStore => {
      void agentDir;
      return { version: 1, profiles: {} };
    },
  ),
  listProfilesForProvider: vi.fn((): string[] => []),
  removeModelAuthCredentials: vi.fn(async () => {}),
  saveModelProviderApiKey:
    vi.fn<typeof import("../../commands/models/auth-api-key.js").saveModelProviderApiKey>(),
  setAuthProfileOrder: vi.fn(async (): Promise<AuthProfileStore | null> => ({
    version: 1,
    profiles: {},
  })),
  refreshActiveProviderAuthRuntimeSnapshot: vi.fn(async () => false),
  prepareModelRuntimeSnapshot: vi.fn(async () => {}),
  loadDeferredCatalog: vi.fn(),
  readPreparedCatalog: vi.fn(),
  buildAuthHealthSummary: vi.fn<BuildAuthHealthSummary>((): AuthHealthSummary => ({
    now: 0,
    warnAfterMs: 0,
    profiles: [],
    providers: [],
  })),
  loadProviderUsageSummary: vi.fn(async (): Promise<UsageSummary> => emptyUsageSummary()),
  listProviderUsagePluginDescriptors: vi.fn(() => [
    { provider: "anthropic", displayName: "Claude" },
    { provider: "deepseek", displayName: "DeepSeek" },
    { provider: "openai", displayName: "OpenAI" },
  ]),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-profiles.js")>(
    "../../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStoreWithoutExternalProfilesAsync:
      mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync,
    listProfilesForProvider: mocks.listProfilesForProvider,
    setAuthProfileOrder: mocks.setAuthProfileOrder,
  };
});

vi.mock("../../commands/models/auth-api-key.js", () => ({
  saveModelProviderApiKey: mocks.saveModelProviderApiKey,
}));

vi.mock("../../commands/models/auth-logout.js", () => ({
  removeModelAuthCredentials: mocks.removeModelAuthCredentials,
}));

vi.mock("../../agents/auth-health.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-health.js")>(
    "../../agents/auth-health.js",
  );
  return {
    ...actual,
    buildAuthHealthSummary: mocks.buildAuthHealthSummary,
  };
});

vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  listProviderUsagePluginDescriptors: mocks.listProviderUsagePluginDescriptors,
}));

vi.mock("../../secrets/runtime.js", () => ({
  refreshActiveProviderAuthRuntimeSnapshot: mocks.refreshActiveProviderAuthRuntimeSnapshot,
}));

vi.mock("../../agents/prepared-model-runtime.js", () => ({
  prepareModelRuntimeSnapshot: mocks.prepareModelRuntimeSnapshot,
}));

vi.mock("../server-model-catalog-auth.js", () => ({
  loadDeferredCatalog: mocks.loadDeferredCatalog,
  readPreparedCatalog: mocks.readPreparedCatalog,
}));

import { createDeferred } from "../../../test/helpers/promise.js";
import { modelsAuthOrderHandlers } from "./models-auth-order.js";
import { clearModelAuthStatusUsageCache } from "./models-auth-status-usage-cache.js";
import { modelsAuthStatusHandlers } from "./models-auth-status.js";
import type { ModelAuthLogoutResult, ModelAuthStatusResult } from "./models-auth-status.types.js";

function createOptions(
  params: Record<string, unknown> = {},
  scopes: string[] = ["operator.admin"],
): GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn();
  return {
    req: { type: "req", id: "req-1", method: "models.authStatus", params },
    params,
    client: { connect: { scopes } } as never,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: mocks.getRuntimeConfig } as unknown,
  } as unknown as GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };
}

const handler = expectDefined(
  modelsAuthStatusHandlers["models.authStatus"],
  'modelsAuthStatusHandlers["models.authStatus"] test invariant',
);
const logoutHandler = expectDefined(
  modelsAuthStatusHandlers["models.authLogout"],
  'modelsAuthStatusHandlers["models.authLogout"] test invariant',
);
const setApiKeyHandler = expectDefined(
  modelsAuthStatusHandlers["models.authSetApiKey"],
  'modelsAuthStatusHandlers["models.authSetApiKey"] test invariant',
);
const orderHandler = expectDefined(
  modelsAuthOrderHandlers["models.authOrderSet"],
  'modelsAuthOrderHandlers["models.authOrderSet"] test invariant',
);

function createActiveRun(providerId: string, authProviderId?: string, agentId = "main") {
  return {
    controller: new AbortController(),
    sessionId: `session-${providerId}`,
    sessionKey: `agent:${agentId}:${providerId}`,
    agentId,
    startedAtMs: 1,
    expiresAtMs: 60_000,
    providerId,
    authProviderId,
  };
}

function oauthCredential(
  provider: string,
  overrides: Partial<Extract<AuthProfileStore["profiles"][string], { type: "oauth" }>> = {},
) {
  return {
    type: "oauth" as const,
    provider,
    access: "access",
    refresh: "refresh",
    expires: 1_000_000,
    ...overrides,
  };
}

type HealthProfile = AuthHealthSummary["profiles"][number];

function healthProfile(
  provider: string,
  type: HealthProfile["type"],
  status: HealthProfile["status"],
  profileId = `${provider}:default`,
  extra: Partial<HealthProfile> = {},
): HealthProfile {
  return { profileId, provider, type, status, source: "store", label: profileId, ...extra };
}

function createApiKeyProfile(provider: string) {
  return healthProfile(provider, "api_key", "static");
}

function mockHealthProvider(provider: AuthHealthSummary["providers"][number], now = 0) {
  mocks.buildAuthHealthSummary.mockReturnValue({
    now,
    warnAfterMs: 0,
    profiles: provider.profiles,
    providers: [provider],
  });
}

function createStaticApiKeyProvider(provider: string) {
  return {
    provider,
    status: "static",
    profiles: [createApiKeyProfile(provider)],
  } satisfies AuthHealthSummary["providers"][number];
}

function createLogoutOptions(
  params: Record<string, unknown> = {},
): GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: mocks.getRuntimeConfig,
    chatAbortControllers: new Map(),
    chatRunState: createChatRunState(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
  };
  return {
    req: { type: "req", id: "req-logout", method: "models.authLogout", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context,
  } as unknown as GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };
}

function setLogoutProfiles(profiles: AuthProfileStore["profiles"]) {
  mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync.mockReturnValue(
    createAuthProfileStoreFixture(profiles),
  );
  mocks.listProfilesForProvider.mockReturnValue(Object.keys(profiles));
}

function createOrderOptions(
  params: Record<string, unknown>,
): GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> } {
  const opts = createOptions(params);
  opts.req.method = "models.authOrderSet";
  opts.client = null;
  return opts;
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");
let preparedAuthStore: AuthProfileStore = { version: 1, profiles: {} };
let preparedMetadataSnapshot: unknown;

function setPreparedAuthStore(store: RuntimeAuthProfileStore): void {
  preparedAuthStore = store;
  replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: "/tmp/agent", store }]);
}

function setPreparedMetadataSnapshot(snapshot: unknown): void {
  preparedMetadataSnapshot = snapshot;
}

function createPreparedOwnerSnapshot(agentId: string) {
  const config = mocks.getRuntimeConfig.mock.results.at(-1)?.value ?? {};
  const agentDir =
    mocks.resolveAgentDir.mock.results.at(-1)?.value ??
    (agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`);
  return {
    agentId,
    agentDir,
    workspaceDir: "/tmp/workspace",
    config,
    entries: [],
    routeVariants: [],
    authModes: {},
    authStore: preparedAuthStore,
    authMaterializations: [],
    metadataSnapshot: preparedMetadataSnapshot as never,
  };
}

function firstRespondCall(
  opts: GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> },
) {
  return opts.respond.mock.calls[0];
}

function expectUnknownAgentId(opts: Parameters<typeof firstRespondCall>[0], agentId: string) {
  expect(firstRespondCall(opts)).toEqual([
    false,
    undefined,
    {
      code: "INVALID_REQUEST",
      message: `unknown agent id "${agentId}"`,
      details: { code: "UNKNOWN_AGENT_ID", agentId },
    },
  ]);
}

async function firstAuthStatusProvider() {
  return (await readAuthStatus()).providers[0];
}

async function readAuthStatus(params: Record<string, unknown> = {}) {
  const opts = createOptions(params);
  await handler(opts);
  const [ok, payload, error] = firstRespondCall(opts) ?? [];
  expect(ok, JSON.stringify(error)).toBe(true);
  return payload as ModelAuthStatusResult;
}

async function warmOAuthUsage() {
  mocks.loadProviderUsageSummary.mockResolvedValue({
    updatedAt: 0,
    providers: [
      { provider: "openai", displayName: "OpenAI", windows: [{ label: "5h", usedPercent: 10 }] },
    ],
  });
  await readAuthStatus();
  await waitForFast(async () => {
    expect((await readAuthStatus()).providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
  });
}

function resetAuthStatusMocks(): void {
  for (const envVarNames of Object.values(
    resolveProviderAuthLookupMaps({ env: {} }).envCandidateMap,
  )) {
    for (const envVarName of envVarNames) {
      vi.stubEnv(envVarName, "");
    }
  }
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.clearAllMocks();
  clearModelAuthStatusUsageCache();
  mocks.getRuntimeConfig.mockReturnValue({});
  mocks.listAgentIds.mockReturnValue(["main"]);
  mocks.resolveAgentDir.mockImplementation((_cfg: unknown, agentId: string) =>
    agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`,
  );
  mocks.resolveDefaultAgentId.mockReturnValue("main");
  setPreparedAuthStore({ version: 1, profiles: {} });
  setPreparedMetadataSnapshot(createPluginMetadataSnapshotFixture());
  mocks.readPreparedCatalog.mockImplementation(async (_context, agentId: string) =>
    createPreparedOwnerSnapshot(agentId),
  );
  mocks.loadDeferredCatalog.mockImplementation(async (_context, agentId: string) =>
    createPreparedOwnerSnapshot(agentId),
  );
  mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync.mockReturnValue(
    createAuthProfileStoreFixture({}),
  );
  mocks.listProfilesForProvider.mockReturnValue([]);
  mocks.removeModelAuthCredentials.mockResolvedValue();
  mocks.saveModelProviderApiKey.mockResolvedValue({ profileId: "openrouter:manual" });
  mocks.setAuthProfileOrder.mockResolvedValue({ version: 1, profiles: {} });
  mocks.buildAuthHealthSummary.mockReturnValue({
    now: 0,
    warnAfterMs: 0,
    profiles: [],
    providers: [],
  });
  mocks.loadProviderUsageSummary.mockResolvedValue(emptyUsageSummary());
  mocks.refreshActiveProviderAuthRuntimeSnapshot.mockResolvedValue(false);
  mocks.prepareModelRuntimeSnapshot.mockResolvedValue();
}

function firstDeferredAuthScope() {
  expect(mocks.loadDeferredCatalog).toHaveBeenCalledTimes(1);
  const [, agentId, options] = mocks.loadDeferredCatalog.mock.calls[0] ?? [];
  expect(agentId).toBe("main");
  const deferredOptions = requireRecord(options);
  expect(deferredOptions.readOnly).toBe(true);
  expect(deferredOptions.refreshAuth).toBe(true);
  expect(deferredOptions.refreshFullCatalog).toBe(false);
  return requireRecord(deferredOptions.authScope);
}

beforeEach(resetAuthStatusMocks);

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
});

function createOpenAiCodexOauthHealthSummary(): AuthHealthSummary {
  const profile = healthProfile("openai", "oauth", "ok", "openai:default", {
    expiresAt: 1_000_000,
    remainingMs: 60_000,
  });
  return {
    now: 0,
    warnAfterMs: 0,
    profiles: [profile],
    providers: [
      {
        provider: "openai",
        status: "ok",
        expiresAt: 1_000_000,
        remainingMs: 60_000,
        profiles: [profile],
      },
    ],
  };
}

describe("models.authStatus", () => {
  it("rejects an explicit unknown agentId before reading auth state", async () => {
    const cfg = { agents: { entries: { main: {}, writer: {} } } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);
    const opts = createOptions({ agentId: "retired", refresh: true });

    await handler(opts);

    expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
    expect(mocks.readPreparedCatalog).not.toHaveBeenCalled();
    expect(mocks.loadDeferredCatalog).not.toHaveBeenCalled();
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).not.toHaveBeenCalled();
    expectUnknownAgentId(opts, "retired");
  });

  it.each(["???", "   "])(
    "rejects explicit id %j when it collapses to the normalization fallback",
    async (agentId) => {
      const cfg = { agents: { entries: { main: {} } } };
      mocks.getRuntimeConfig.mockReturnValue(cfg);
      mocks.listAgentIds.mockReturnValue(["main"]);
      const opts = createOptions({ agentId });

      await handler(opts);

      expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
      expect(mocks.readPreparedCatalog).not.toHaveBeenCalled();
      expectUnknownAgentId(opts, agentId);
    },
  );

  it("reports an unavailable prepared owner without failing the RPC or discovering credentials", async () => {
    mocks.readPreparedCatalog.mockResolvedValueOnce(undefined);

    const unavailable = await readAuthStatus();

    expect(unavailable).toEqual({
      ts: expect.any(Number),
      providers: [],
      unavailable: {
        code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
        message: expect.stringContaining("Refresh Models"),
      },
    });
    expect(mocks.loadDeferredCatalog).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).not.toHaveBeenCalled();
    expect(mocks.buildAuthHealthSummary).not.toHaveBeenCalled();
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();

    const recovered = await readAuthStatus();
    expect(recovered).not.toHaveProperty("unavailable");
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledOnce();
  });

  it("projects explicit priority with local reset ownership", async () => {
    setPreparedAuthStore({
      version: 1,
      profiles: {
        "openai:default": oauthCredential("openai", {
          email: "owner@example.com",
          displayName: "Work account",
        }),
      },
      order: { openai: ["openai:default"] },
      runtimeLocalOrderProviderIds: ["openai"],
      usageStats: { "openai:default": { lastUsed: 42 } },
    });
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());

    const provider = await firstAuthStatusProvider();

    expect(provider?.profileOrder).toEqual(["openai:default"]);
    expect(provider?.profileOrderStored).toBe(true);
    expect(provider?.profiles[0]).toMatchObject({
      displayName: "Work account",
      email: "owner@example.com",
      lastUsedAt: 42,
      source: "saved",
    });
  });

  it("keeps shared auth facts private across concurrent client scopes", async () => {
    setPreparedAuthStore({
      version: 1,
      profiles: {
        "openai:default": oauthCredential("openai", {
          email: "owner@example.com",
          displayName: "Work account",
        }),
      },
      usageStats: { "openai:default": { lastUsed: 42 } },
    });
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());

    const admin = createOptions({ agentId: "main" });
    const reader = createOptions({ agentId: "main" }, ["operator.read"]);
    await Promise.all(
      [admin, reader].map(async (opts) => {
        await handler(opts);
      }),
    );

    expect(firstRespondCall(admin)?.[1]?.providers[0]?.profiles[0]).toMatchObject({
      email: "owner@example.com",
      displayName: "Work account",
      lastUsedAt: 42,
    });
    const result = firstRespondCall(reader)?.[1] as ModelAuthStatusResult;
    expect(result.providers[0]?.profiles[0]).not.toHaveProperty("email");
    expect(result.providers[0]?.profiles[0]).not.toHaveProperty("displayName");
    expect(result.providers[0]?.profiles[0]).not.toHaveProperty("lastUsedAt");
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);
  });

  it("marks externally supplied profiles and configuration-owned priority", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      auth: { order: { openai: ["openai:default"] } },
    });
    setPreparedAuthStore({
      version: 1,
      profiles: {
        "openai:default": oauthCredential("openai"),
      },
      runtimeExternalProfileIds: ["openai:default"],
    });
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());

    const provider = await firstAuthStatusProvider();

    expect(provider?.profileOrderLocked).toBe("auth-config");
    expect(provider?.profiles[0]?.source).toBe("external");
    expect(provider?.profiles[0]?.logoutSupported).toBeUndefined();
  });

  it("locks alias priority to the configured credential", async () => {
    const boundProfileId = "minimax:cn";
    const config = {
      auth: {
        order: {
          minimax: ["minimax:global", "minimax:cn"],
          anthropic: ["anthropic:saved"],
        },
      },
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/v1",
            apiKey: boundProfileId,
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    mocks.getRuntimeConfig.mockReturnValue(config);
    setPreparedAuthStore(
      createAuthProfileStoreFixture({
        "minimax:global": { type: "token", provider: "minimax", token: "global-token" },
        "minimax:cn": { type: "token", provider: "minimax-cn", token: "cn-token" },
        "anthropic:saved": { type: "token", provider: "anthropic", token: "other-token" },
      }),
    );
    setPreparedMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "minimax",
            origin: "bundled",
            providers: ["minimax"],
            providerAuthAliases: { "minimax-cn": "minimax" },
          },
        ],
      }),
    );
    const actualAuthHealth = await vi.importActual<typeof import("../../agents/auth-health.js")>(
      "../../agents/auth-health.js",
    );
    mocks.buildAuthHealthSummary.mockImplementation(actualAuthHealth.buildAuthHealthSummary);

    const result = await readAuthStatus();

    expect(result.providers).toMatchObject([
      { provider: "anthropic", authProvider: "anthropic", profileOrderLocked: "auth-config" },
      { provider: "minimax", authProvider: "minimax", profileOrderLocked: "provider-config" },
      { provider: "minimax-cn", authProvider: "minimax", profileOrderLocked: "provider-config" },
    ]);
    const profiles = result.providers.flatMap((provider) => provider.profiles);
    const boundProfile = profiles.find((profile) => profile.profileId === boundProfileId);
    expect(boundProfile).toMatchObject({ source: "config", logoutSupported: true });
    for (const profile of profiles.filter((candidate) => candidate.profileId !== boundProfileId)) {
      expect(profile).toMatchObject({ source: "saved", logoutSupported: true });
    }

    mocks.getRuntimeConfig.mockReturnValue({ ...config, auth: {} });
    for (const provider of ["minimax", "minimax-cn"]) {
      const opts = createOrderOptions({
        provider,
        profileIds: ["minimax:cn", "minimax:global"],
      });
      await orderHandler(opts);
      expect(firstRespondCall(opts)?.[0]).toBe(false);
      expect(firstRespondCall(opts)?.[2]?.message).toContain("provider configuration");
    }
    expect(mocks.setAuthProfileOrder).not.toHaveBeenCalled();
  });

  it("projects provider capabilities from the published lifecycle metadata", async () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "provider-auth",
          origin: "bundled",
          providers: ["OpenAI", "github-copilot", "media-only"],
          providerAuthAliases: { "openai-legacy": "openai" },
          providerAuthChoices: [
            {
              provider: "openai-legacy",
              method: "api-key",
              choiceId: "openai-api-key",
              choiceLabel: "OpenAI API key",
              appGuidedSecret: true,
            },
            {
              provider: "openai",
              method: "oauth",
              choiceId: "openai-oauth",
              choiceLabel: "OpenAI OAuth",
            },
            {
              provider: "media-only",
              method: "api-key",
              choiceId: "media-only-key",
              choiceLabel: "Media API key",
              onboardingScopes: ["image-generation"],
            },
            {
              provider: "github-copilot",
              method: "oauth",
              choiceId: "github-copilot-oauth",
              choiceLabel: "GitHub Copilot OAuth",
            },
          ],
        },
        {
          id: "search-tool",
          setup: { providers: [{ id: "search-tool", authMethods: ["api-key"] }] },
        },
      ],
    });
    setPreparedMetadataSnapshot(snapshot);

    const result = await readAuthStatus();

    expect(result.providerCapabilities).toEqual([
      { provider: "github-copilot", apiKeySupported: false, quickApiKeySetup: false },
      { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
    ]);
  });

  it("uses the published metadata owner for provider env auth and aliases", async () => {
    const cfg = {};
    const policyHash = resolveInstalledPluginIndexPolicyHash(cfg);
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "prepared-auth",
          origin: "bundled",
          setup: {
            providers: [{ id: "prepared-owner", envVars: ["PREPARED_OWNER_API_KEY"] }],
          },
          providerAuthAliases: { "prepared-owner-alias": "prepared-owner" },
        },
      ],
    });
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    setPreparedMetadataSnapshot({
      ...snapshot,
      policyHash,
      index: { ...snapshot.index, policyHash },
    });
    vi.stubEnv("PREPARED_OWNER_API_KEY", "prepared-owner-secret");

    await handler(createOptions());

    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.arrayContaining(["prepared-owner", "prepared-owner-alias"]),
      }),
    );
  });

  it("observes external CLI bootstrap changes without an auth publication", async () => {
    const actual = await vi.importActual<typeof import("../../agents/auth-health.js")>(
      "../../agents/auth-health.js",
    );
    const cli = await import("../../agents/cli-credentials.js");
    const readExternal = vi.spyOn(cli, "readMiniMaxCliCredentialsCached").mockReturnValue(null);
    mocks.buildAuthHealthSummary.mockImplementation(actual.buildAuthHealthSummary);
    const profileId = "minimax-portal:minimax-cli";
    setPreparedAuthStore(
      createAuthProfileStoreFixture({
        [profileId]: oauthCredential("minimax-portal", {
          access: "fixture-expired-access",
          refresh: "fixture-refresh",
          expires: 1,
        }),
      }),
    );
    try {
      expect((await firstAuthStatusProvider())?.status).toBe("expired");
      readExternal.mockReturnValue({
        type: "oauth",
        provider: "minimax-portal",
        access: "fixture-new-access",
        refresh: "fixture-new-refresh",
        expires: Date.now() + 2 * 24 * 60 * 60_000,
      });
      expect((await firstAuthStatusProvider())?.status).toBe("ok");
    } finally {
      readExternal.mockRestore();
    }
  });

  it("reports credential provenance without returning config or environment secrets", async () => {
    vi.stubEnv("MODELS_AUTH_STATUS_PROVENANCE_KEY", "env-secret-value");
    vi.stubEnv("DEEPSEEK_API_KEY", "marker-secret-value");
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: { baseUrl: "https://example.test/v1", models: [], apiKey: "inline-secret-value" },
          anthropic: {
            baseUrl: "https://example.test/v1",
            models: [],
            apiKey: { source: "env", provider: "default", id: "MODELS_AUTH_STATUS_PROVENANCE_KEY" },
          },
          deepseek: { baseUrl: "https://example.test/v1", models: [], apiKey: "DEEPSEEK_API_KEY" },
          openrouter: {
            baseUrl: "https://example.test/v1",
            models: [],
            apiKey: { source: "file", provider: "mounted-json", id: "model-provider-key" },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          ...sourceConfig.models?.providers,
          openrouter: {
            baseUrl: "https://example.test/v1",
            models: [],
            apiKey: "runtime-secret-value",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    const providers = ["openai", "anthropic", "deepseek"].map(createStaticApiKeyProvider);
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: 0,
      warnAfterMs: 0,
      profiles: providers.flatMap((provider) => provider.profiles),
      providers: [...providers, { provider: "openrouter", status: "missing", profiles: [] }],
    });

    const result = await readAuthStatus();

    expect(
      Object.fromEntries(result.providers.map((provider) => [provider.provider, provider.apiKey])),
    ).toEqual({
      openai: { source: "config" },
      anthropic: { source: "env", envVar: "MODELS_AUTH_STATUS_PROVENANCE_KEY" },
      deepseek: { source: "env", envVar: "DEEPSEEK_API_KEY" },
      openrouter: { source: "config" },
    });
    expect(result.providers.find((provider) => provider.provider === "openrouter")?.status).toBe(
      "static",
    );
    for (const secret of [
      "inline-secret-value",
      "env-secret-value",
      "marker-secret-value",
      "runtime-secret-value",
    ]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("keeps unresolved credentials missing and excludes local no-auth markers", async () => {
    const actual = await vi.importActual<typeof import("../../agents/auth-health.js")>(
      "../../agents/auth-health.js",
    );
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          anthropic: { apiKey: "ANTHROPIC_API_KEY" },
          openai: { apiKey: NON_ENV_SECRETREF_MARKER },
          ollama: { apiKey: "ollama-local" },
        },
      },
    });
    mocks.buildAuthHealthSummary.mockImplementationOnce(actual.buildAuthHealthSummary);

    const result = await readAuthStatus();

    expect(
      result.providers.map(({ provider, status, apiKey }) => ({ provider, status, apiKey })),
    ).toEqual([
      { provider: "anthropic", status: "missing", apiKey: undefined },
      { provider: "openai", status: "missing", apiKey: undefined },
    ]);
  });

  it("invalidates shared auth facts on metadata publication", async () => {
    await readAuthStatus();
    setPreparedMetadataSnapshot(createPluginMetadataSnapshotFixture());
    mocks.buildAuthHealthSummary.mockReturnValue({
      now: Date.now(),
      warnAfterMs: 0,
      profiles: [],
      providers: [{ provider: "anthropic", status: "missing", profiles: [] }],
    });
    const result = await readAuthStatus();
    expect(result.providers[0]?.status).toBe("missing");
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
    await readAuthStatus();
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("updates expiry labels on cache hits and health at warning and expiry boundaries", async () => {
    const actual = await vi.importActual<typeof import("../../agents/auth-health.js")>(
      "../../agents/auth-health.js",
    );
    mocks.buildAuthHealthSummary.mockImplementation(actual.buildAuthHealthSummary);
    mocks.getRuntimeConfig.mockReturnValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
    });
    const now = 1_000_000;
    const day = 24 * 60 * 60_000;
    const expires = now + 2 * day;
    setPreparedAuthStore(
      createAuthProfileStoreFixture({
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "fixture-token",
          expires,
        },
      }),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(now);
      expect((await readAuthStatus()).providers[0]?.status).toBe("ok");
      vi.setSystemTime(now + 60_000);
      expect((await readAuthStatus()).providers[0]?.profiles[0]?.expiry?.remainingMs).toBe(
        2 * day - 60_000,
      );
      expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);
      vi.setSystemTime(expires - day);
      expect((await readAuthStatus()).providers[0]?.status).toBe("expiring");
      vi.setSystemTime(expires);
      expect((await readAuthStatus()).providers[0]?.status).toBe("expired");
      expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish usage captured before a concurrent logout", async () => {
    mocks.removeModelAuthCredentials.mockImplementationOnce(async () => {
      setPreparedAuthStore({ version: 1, profiles: {} });
    });
    let releaseUsage: (() => void) | undefined;
    let usageFinished = false;
    const usageBlocked = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    const oauthProfile = healthProfile("openrouter", "oauth", "ok", "openrouter:default");
    mockHealthProvider({ provider: "openrouter", status: "ok", profiles: [oauthProfile] });
    mocks.loadProviderUsageSummary.mockImplementationOnce(async () => {
      await usageBlocked;
      usageFinished = true;
      return {
        updatedAt: 0,
        providers: [
          {
            provider: "openrouter",
            displayName: "OpenRouter",
            windows: [{ label: "day", usedPercent: 99 }],
          },
        ],
      };
    });

    const first = await readAuthStatus();
    expect(first.providers[0]?.usage).toBeUndefined();
    await waitForFast(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce());
    await logoutHandler(createLogoutOptions({ provider: "openrouter" }));
    releaseUsage?.();
    await waitForFast(() => expect(usageFinished).toBe(true));

    const afterLogout = await readAuthStatus();
    expect(afterLogout.providers[0]?.usage).toBeUndefined();
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("routes claude-cli OAuth profiles to Anthropic usage with plan and billing", async () => {
    const runtimeConfig = {};
    const plugins = [
      {
        id: "anthropic",
        origin: "bundled" as const,
        providerAuthAliases: { "claude-cli": "anthropic" },
      },
    ];
    setPreparedMetadataSnapshot(createPluginMetadataSnapshotFixture({ plugins }));
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    const profile = healthProfile("claude-cli", "oauth", "ok", "claude-cli");
    mockHealthProvider({ provider: "claude-cli", status: "ok", profiles: [profile] });
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          plan: "Max (20x)",
          accountEmail: "clawd@example.com",
          windows: [{ label: "5h", usedPercent: 22 }],
          billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
        },
      ],
    });

    const first = await readAuthStatus();
    expect(first.providers[0]?.usage).toBeUndefined();

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      providers: ["anthropic"],
      agentDir: "/tmp/agent",
      authStore: preparedAuthStore,
      config: runtimeConfig,
      timeoutMs: 5_000,
    });
    let result: ModelAuthStatusResult | undefined;
    await waitForFast(async () => {
      result = await readAuthStatus();
      expect(result.providers[0]?.usage).toBeDefined();
    });
    const refreshed = expectDefined(result, "refreshed auth status");
    expect(refreshed.providers[0]?.displayName).toBe("Claude");
    expect(refreshed.providers[0]?.authProvider).toBe("anthropic");
    expect(refreshed.providers[0]?.usage).toEqual({
      providerId: "anthropic",
      windows: [{ label: "5h", usedPercent: 22 }],
      plan: "Max (20x)",
      billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
      accountEmail: "clawd@example.com",
    });

    const readOnly = createOptions({}, ["operator.read"]);
    await handler(readOnly);
    const readOnlyResult = firstRespondCall(readOnly)?.[1] as ModelAuthStatusResult;
    expect(readOnlyResult.providers[0]?.usage).not.toHaveProperty("accountEmail");
  });

  it("adds DeepSeek API-key balance summaries to auth status usage", async () => {
    mockHealthProvider(createStaticApiKeyProvider("deepseek"));
    mocks.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "deepseek",
          displayName: "DeepSeek",
          windows: [],
          summary: "Balance ¥42.50",
        },
      ],
    });

    const first = await readAuthStatus();
    expect(first.providers[0]?.usage).toBeUndefined();

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      providers: ["deepseek"],
      agentDir: "/tmp/agent",
      authStore: preparedAuthStore,
      config: expect.any(Object),
      timeoutMs: 5_000,
    });
    let result: ModelAuthStatusResult | undefined;
    await waitForFast(async () => {
      result = await readAuthStatus();
      expect(result.providers[0]?.usage).toBeDefined();
    });
    const refreshed = expectDefined(result, "refreshed auth status");
    expect(refreshed.providers[0]?.usage).toEqual({
      providerId: "deepseek",
      windows: [],
      summary: "Balance ¥42.50",
    });
  });

  it("keeps same-account stale usage visible during an explicit refresh", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    await warmOAuthUsage();

    const { promise: refreshBlocked, resolve: releaseRefresh } = createDeferred();
    mocks.loadProviderUsageSummary.mockImplementationOnce(async () => {
      await refreshBlocked;
      return {
        updatedAt: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 20 }],
          },
        ],
      };
    });

    const refreshing = await readAuthStatus({ refresh: true });
    expect(refreshing.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    const concurrent = await readAuthStatus({ refresh: true });
    expect(concurrent.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    releaseRefresh();
    await waitForFast(async () => {
      expect((await readAuthStatus()).providers[0]?.usage?.windows[0]?.usedPercent).toBe(20);
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });

  it.each(["directory", "credentials"] as const)(
    "does not reuse usage after the prepared %s changes",
    async (change) => {
      mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
      setPreparedAuthStore(
        createAuthProfileStoreFixture({
          "openai:default": oauthCredential("openai", {
            access: "first-access",
            refresh: "first-refresh",
          }),
        }),
      );
      await warmOAuthUsage();
      if (change === "directory") {
        mocks.resolveAgentDir.mockReturnValue("/tmp/rebound-agent");
      } else {
        // The prepared owner can advance before the ambient snapshot revision.
        preparedAuthStore = createAuthProfileStoreFixture({
          "openai:default": oauthCredential("openai", {
            access: "second-access",
            refresh: "second-refresh",
          }),
        });
      }
      const result = await readAuthStatus();
      expect(result.providers[0]?.usage).toBeUndefined();
      expect(mocks.buildAuthHealthSummary.mock.calls.at(-1)?.[0].store).toBe(preparedAuthStore);
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
      expect(mocks.loadProviderUsageSummary).toHaveBeenLastCalledWith({
        providers: ["openai"],
        agentDir: change === "directory" ? "/tmp/rebound-agent" : "/tmp/agent",
        authStore: preparedAuthStore,
        config: expect.any(Object),
        timeoutMs: 5_000,
      });
    },
  );

  it("refreshes only configured CLI auth from the latest runtime config", async () => {
    const cfg = {
      auth: {
        profiles: {
          "opencode-go:default": { provider: "opencode-go", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "opencode-go/kimi-k2.6" },
        },
      },
      models: {
        providers: {
          "opencode-go": {
            baseUrl: "https://example.test/v1",
            auth: "api-key",
            models: [],
          },
        },
      },
    };
    mocks.getRuntimeConfig.mockReturnValueOnce({}).mockReturnValue(cfg);

    await readAuthStatus({ refresh: true });
    expect(mocks.getRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledWith(expect.objectContaining({ cfg }));

    const authScope = firstDeferredAuthScope();
    expect(authScope.providerIds).toContain("opencode-go");
    expect(authScope.providerIds).not.toContain("claude-cli");
    expect(authScope.profileIds).toEqual(["opencode-go:default"]);
  });

  it("still returns providers when usage fetch fails", async () => {
    mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
    mocks.loadProviderUsageSummary.mockRejectedValue(new Error("timeout"));

    const opts = createOptions();
    await handler(opts);

    const [ok, payload] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    const result = payload as ModelAuthStatusResult;
    expect(result.providers).toHaveLength(1);
    expect(
      expectDefined(result.providers[0], "result.providers[0] test invariant").usage,
    ).toBeUndefined();
  });

  it("does not leak secret-looking fields from upstream profile data", async () => {
    const profile = {
      ...healthProfile("openai", "oauth", "ok", "openai:default", { expiresAt: 1, remainingMs: 1 }),
      access: "sk-SECRET-TOKEN",
      refresh: "rt-SECRET-REFRESH",
    };
    mockHealthProvider({
      provider: "openai",
      status: "ok",
      expiresAt: 1,
      remainingMs: 1,
      profiles: [profile],
    });
    const result = await readAuthStatus();
    expect(result.providers).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(profile.access);
    expect(JSON.stringify(result)).not.toContain(profile.refresh);
  });

  it("flags OAuth configuration with only API-key credentials as missing", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      models: { providers: { anthropic: { auth: "oauth" } } },
    });
    mockHealthProvider(createStaticApiKeyProvider("anthropic"));
    expect((await firstAuthStatusProvider())?.status).toBe("missing");
  });
});

describe("models.authOrderSet", () => {
  beforeEach(() => {
    setPreparedAuthStore(
      createAuthProfileStoreFixture({
        "openai:one": oauthCredential("openai", { access: "one", refresh: "one-refresh" }),
        "openai:two": oauthCredential("openai", { access: "two", refresh: "two-refresh" }),
      }),
    );
  });

  it("publishes the durable order before acknowledging it", async () => {
    const publication = createDeferred();
    const started = createDeferred();
    mocks.prepareModelRuntimeSnapshot.mockImplementationOnce(() => {
      started.resolve();
      return publication.promise;
    });
    const opts = createOrderOptions({
      provider: "openai",
      profileIds: ["openai:two", "openai:one"],
    });

    const pending = orderHandler(opts);
    await started.promise;

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/agent",
      provider: "openai",
      order: ["openai:two", "openai:one"],
    });
    expect(opts.respond).not.toHaveBeenCalled();
    expect(mocks.prepareModelRuntimeSnapshot).toHaveBeenCalledWith({
      agentId: "main",
      agentDir: "/tmp/agent",
      config: {},
    });

    publication.resolve();
    await pending;
    expect(firstRespondCall(opts)?.slice(0, 2)).toEqual([
      true,
      { provider: "openai", profileIds: ["openai:two", "openai:one"] },
    ]);
  });

  it("preserves the committed reset when runtime publication fails", async () => {
    mocks.prepareModelRuntimeSnapshot.mockRejectedValueOnce(new Error("publication failed"));
    const opts = createOrderOptions({ provider: "openai" });
    await orderHandler(opts);
    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/agent",
      provider: "openai",
      order: null,
    });
    expect(firstRespondCall(opts)).toEqual([
      true,
      {
        provider: "openai",
        profileIds: null,
        warning: expect.stringContaining("Profile priority saved"),
      },
      undefined,
    ]);
  });

  it.each([
    {
      params: { provider: "openai", profileIds: ["openai:two", "openai:one"] },
      config: { auth: { order: { openai: ["openai:one", "openai:two"] } } },
      message: "auth configuration",
    },
    {
      params: { provider: "openai", profileIds: ["openai:one"] },
      message: "every available profile",
    },
    {
      params: { provider: "anthropic", profileIds: ["openai:one"] },
      message: "unavailable for provider anthropic",
    },
    {
      params: { provider: "openai", unexpected: true },
      message: "invalid models.authOrderSet params",
    },
  ])("rejects invalid profile priority without writing: $message", async (scenario) => {
    if (scenario.config) {
      mocks.getRuntimeConfig.mockReturnValue(scenario.config);
    }
    const opts = createOrderOptions(scenario.params);
    await orderHandler(opts);
    expect(mocks.setAuthProfileOrder).not.toHaveBeenCalled();
    expect(firstRespondCall(opts)?.[0]).toBe(false);
    expect(firstRespondCall(opts)?.[2]?.message).toContain(scenario.message);
  });
});

describe("models.authSetApiKey", () => {
  it.each([
    { refreshFails: false, configWarning: undefined },
    { refreshFails: true, configWarning: "Provider settings were saved but not applied." },
  ])(
    "reports a saved key with application and refresh warnings: %j",
    async ({ refreshFails, configWarning }) => {
      const config = { agents: { entries: { main: {}, writer: {} } } };
      mocks.getRuntimeConfig.mockReturnValue(config);
      mocks.listAgentIds.mockReturnValue(["main", "writer"]);
      mocks.saveModelProviderApiKey.mockResolvedValueOnce({
        profileId: "openrouter:manual",
        warning: configWarning,
      });
      if (refreshFails) {
        mocks.refreshActiveProviderAuthRuntimeSnapshot.mockRejectedValueOnce(
          new Error("refresh failed"),
        );
      }
      const opts = createOptions({ provider: "OpenRouter", apiKey: "test-key", agentId: "Writer" });

      await setApiKeyHandler(opts);

      expect(validateModelsAuthSetApiKeyResult(firstRespondCall(opts)?.[1])).toBe(true);
      expect(mocks.saveModelProviderApiKey).toHaveBeenCalledWith({
        config,
        provider: "openrouter",
        apiKey: "test-key",
        agentDir: "/tmp/agent-writer",
      });
      expect(firstRespondCall(opts)).toEqual([
        true,
        {
          provider: "openrouter",
          profileId: "openrouter:manual",
          ...(refreshFails || configWarning ? { warning: expect.any(String) } : {}),
        },
        undefined,
      ]);
      if (configWarning) {
        expect(firstRespondCall(opts)?.[1]?.warning).toContain(configWarning);
      }
      if (refreshFails) {
        expect(firstRespondCall(opts)?.[1]?.warning).toContain("openclaw gateway restart");
      }
    },
  );

  it.each([
    { provider: "", apiKey: "test-key" },
    { provider: "openrouter", apiKey: "test-key", agentId: "retired" },
  ])("rejects invalid save input before writing: %j", async (params) => {
    const opts = createOptions(params);
    await setApiKeyHandler(opts);
    expect(firstRespondCall(opts)).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    ]);
    expect(mocks.saveModelProviderApiKey).not.toHaveBeenCalled();
  });
});

describe("models.authLogout", () => {
  it("rejects an explicit unknown agentId without touching the default auth store", async () => {
    const cfg = { agents: { entries: { main: {}, writer: {} } } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);
    const opts = createLogoutOptions({ provider: "openrouter", agentId: "retired" });

    await logoutHandler(opts);

    expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).not.toHaveBeenCalled();
    expect(mocks.removeModelAuthCredentials).not.toHaveBeenCalled();
    expectUnknownAgentId(opts, "retired");
  });

  it("removes provider auth profiles and invalidates the status cache", async () => {
    const actual = await vi.importActual<typeof import("../../agents/auth-health.js")>(
      "../../agents/auth-health.js",
    );
    mocks.buildAuthHealthSummary.mockImplementation(actual.buildAuthHealthSummary);
    setPreparedAuthStore(
      createAuthProfileStoreFixture({
        "openrouter:default": { type: "api_key", provider: "openrouter", key: "fixture-key" },
      }),
    );
    mocks.removeModelAuthCredentials.mockImplementationOnce(async () => {
      setPreparedAuthStore({ version: 1, profiles: {} });
    });
    mocks.listProfilesForProvider.mockReturnValue(["openrouter:default"]);
    expect((await readAuthStatus()).providers[0]?.profiles[0]?.profileId).toBe(
      "openrouter:default",
    );
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

    const opts = createLogoutOptions({ provider: "OpenRouter" });
    await logoutHandler(opts);

    expect(mocks.removeModelAuthCredentials).toHaveBeenCalledWith({
      cfg: {},
      provider: "openrouter",
      agentDir: "/tmp/agent",
      profileIds: ["openrouter:default"],
    });
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledTimes(1);
    const [ok, payload] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    expect((payload as ModelAuthLogoutResult).removedProfiles).toEqual(["openrouter:default"]);

    expect((await readAuthStatus()).providers).toEqual([]);
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("removes only requested saved OAuth or token profiles", async () => {
    setLogoutProfiles({
      "openrouter:oauth": oauthCredential("openrouter"),
      "openrouter:token": { type: "token", provider: "openrouter", token: "test-token" },
      "openrouter:api-key": {
        type: "api_key",
        provider: "openrouter",
        key: "key",
      },
    });
    const opts = createLogoutOptions({
      provider: "openrouter",
      profileIds: [" openrouter:token ", "openrouter:oauth", "openrouter:token"],
    });

    const run = createActiveRun("openrouter");
    opts.context.chatAbortControllers.set("active", run);
    await logoutHandler(opts);
    expect(run.controller.signal.aborted).toBe(false);
    expect(opts.context.chatAbortControllers.has("active")).toBe(true);

    expect(mocks.removeModelAuthCredentials).toHaveBeenCalledWith({
      cfg: {},
      profileIds: ["openrouter:token", "openrouter:oauth"],
      agentDir: "/tmp/agent",
    });
    const [ok, payload] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      removedProfiles: ["openrouter:token", "openrouter:oauth"],
      abortedRunIds: [],
    });
  });

  it("rejects unavailable or external targeted profiles without aborting runs", async () => {
    setLogoutProfiles({ "openrouter:saved": oauthCredential("openrouter") });
    const opts = createLogoutOptions({
      provider: "openrouter",
      profileIds: ["openrouter:external"],
    });
    const activeRun = createActiveRun("openrouter");
    opts.context.chatAbortControllers.set("run-openrouter", activeRun);

    await logoutHandler(opts);

    expect(mocks.removeModelAuthCredentials).not.toHaveBeenCalled();
    expect(activeRun.controller.signal.aborted).toBe(false);
    const [ok, , error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toContain("unavailable auth profiles");
  });

  const sparseProfileIds: unknown[] = [];
  sparseProfileIds.length = 1;

  it.each([
    { label: "empty", profileIds: [] },
    { label: "non-array", profileIds: "openrouter:oauth" },
    { label: "non-string", profileIds: ["openrouter:oauth", 1] },
    { label: "blank", profileIds: ["openrouter:oauth", " "] },
    { label: "sparse", profileIds: sparseProfileIds },
  ])("rejects $label targeted profile ids", async ({ profileIds }) => {
    const opts = createLogoutOptions({ provider: "openrouter", profileIds });

    await logoutHandler(opts);

    const [ok, , error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toContain("non-empty string array");
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).not.toHaveBeenCalled();
    expect(mocks.removeModelAuthCredentials).not.toHaveBeenCalled();
  });

  it.each([
    { credentialType: "token" },
    { credentialType: "api_key", profileIds: ["openrouter:default"] },
  ])("rejects incompatible logout selectors: %j", async (selection) => {
    const opts = createLogoutOptions({ provider: "openrouter", ...selection });
    await logoutHandler(opts);
    expect(firstRespondCall(opts)).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    ]);
    expect(mocks.removeModelAuthCredentials).not.toHaveBeenCalled();
  });

  it("removes only inline API keys and preserves active provider runs", async () => {
    setLogoutProfiles({
      "openrouter:key": { type: "api_key", provider: "openrouter", key: "test-key" },
      "openrouter:ref": {
        type: "api_key",
        provider: "openrouter",
        keyRef: { source: "env", provider: "default", id: "OPENROUTER_API_KEY" },
      },
      "openrouter:token": { type: "token", provider: "openrouter", token: "test-token" },
      "openrouter:oauth": oauthCredential("openrouter"),
    });
    const opts = createLogoutOptions({ provider: "openrouter", credentialType: "api_key" });
    const run = createActiveRun("openrouter");
    opts.context.chatAbortControllers.set("run-openrouter", run);

    await logoutHandler(opts);

    expect(mocks.removeModelAuthCredentials).toHaveBeenCalledWith({
      cfg: {},
      agentDir: "/tmp/agent",
      profileIds: ["openrouter:key"],
      apiKeyProvider: "openrouter",
    });
    expect(run.controller.signal.aborted).toBe(false);
    expect(opts.context.chatAbortControllers.has("run-openrouter")).toBe(true);
    expect(firstRespondCall(opts)).toEqual([
      true,
      { provider: "openrouter", removedProfiles: ["openrouter:key"], abortedRunIds: [] },
      undefined,
    ]);
  });

  it("does not abort runs when auth profile removal fails", async () => {
    mocks.removeModelAuthCredentials.mockRejectedValue(new Error("removal failed"));
    const opts = createLogoutOptions({ provider: "openrouter" });
    const run = createActiveRun("openrouter");
    opts.context.chatAbortControllers.set("run-openrouter", run);
    await logoutHandler(opts);
    expect(run.controller.signal.aborted).toBe(false);
    expect(opts.context.chatAbortControllers.has("run-openrouter")).toBe(true);
    expect(firstRespondCall(opts)).toEqual([
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("removal failed") }),
    ]);
  });

  it("aborts only revoked provider runs before reporting a committed logout refresh failure", async () => {
    const cfg = { agents: { entries: { main: {}, writer: {} } } };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);
    const opts = createLogoutOptions({ provider: "byteplus", agentId: "writer" });
    const revokedRun = createActiveRun("byteplus", undefined, "writer");
    const aliasedRun = createActiveRun("byteplus-plan", "byteplus", "writer");
    const otherAgentRun = createActiveRun("byteplus", undefined, "main");
    const otherProviderRun = createActiveRun("openai", undefined, "writer");
    opts.context.chatAbortControllers.set("revoked", revokedRun);
    opts.context.chatAbortControllers.set("aliased", aliasedRun);
    opts.context.chatAbortControllers.set("other-agent", otherAgentRun);
    opts.context.chatAbortControllers.set("other-provider", otherProviderRun);
    let revokedAtRefresh = false;
    mocks.prepareModelRuntimeSnapshot.mockImplementationOnce(async () => {
      revokedAtRefresh =
        revokedRun.controller.signal.aborted && aliasedRun.controller.signal.aborted;
      throw new Error("refresh failed");
    });

    await logoutHandler(opts);

    expect(revokedAtRefresh).toBe(true);
    expect(revokedRun.controller.signal.aborted).toBe(true);
    expect(aliasedRun.controller.signal.aborted).toBe(true);
    expect(otherAgentRun.controller.signal.aborted).toBe(false);
    expect(otherProviderRun.controller.signal.aborted).toBe(false);
    expect(opts.context.chatAbortControllers.has("revoked")).toBe(false);
    expect(opts.context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "revoked", state: "aborted", stopReason: "auth-revoked" }),
      { sessionKeys: [revokedRun.sessionKey] },
    );
    const [ok, payload, error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      abortedRunIds: ["revoked", "aliased"],
      warning: expect.stringContaining("openclaw gateway restart"),
    });
    expect(error).toBeUndefined();
  });

  it("rejects missing provider", async () => {
    const opts = createLogoutOptions();
    await logoutHandler(opts);
    const [ok, , error] = firstRespondCall(opts) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toBe("provider is required");
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
