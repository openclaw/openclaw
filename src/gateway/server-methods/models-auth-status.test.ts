import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthHealthSummary } from "../../agents/auth-health.js";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
  type RuntimeAuthProfileStore,
} from "../../agents/auth-profiles.js";
import { createAuthProfileStoreFixture } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import * as authProfileSnapshots from "../../agents/auth-profiles/runtime-snapshots.js";
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
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createChatRunState } from "../server-chat-state.js";
import {
  createOpenAiCodexOauthHealthSummary,
  createStaticApiKeyProvider,
  healthProfile,
  oauthCredential,
} from "./models-auth-status.health.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type BuildAuthHealthSummary = typeof import("../../agents/auth-health.js").buildAuthHealthSummary;
type RespondOptions = GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };

const emptyUsageSummary = (): UsageSummary => ({ updatedAt: 0, providers: [] });

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  listAgentIds: vi.fn(() => ["main"]),
  listAgentEntries: vi.fn(() => []),
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
  refreshRuntimeAuthProfileStoreSources: vi.fn(async () => {}),
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

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  listAgentIds: mocks.listAgentIds,
  listAgentEntries: mocks.listAgentEntries,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles.js")>()),
  ensureAuthProfileStoreWithoutExternalProfilesAsync:
    mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync,
  listProfilesForProvider: mocks.listProfilesForProvider,
  setAuthProfileOrder: mocks.setAuthProfileOrder,
}));

vi.mock("../../commands/models/auth-api-key.js", () => ({
  saveModelProviderApiKey: mocks.saveModelProviderApiKey,
}));

vi.mock("../../commands/models/auth-logout.js", () => ({
  removeModelAuthCredentials: mocks.removeModelAuthCredentials,
}));

vi.mock("../../agents/auth-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-health.js")>()),
  buildAuthHealthSummary: mocks.buildAuthHealthSummary,
}));

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
import { registerModelAuthLogoutTests } from "./models-auth-status.logout.test-support.js";
import { registerModelAuthSetApiKeyTests } from "./models-auth-status.set-api-key.test-support.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";
import { registerModelAuthStatusUsageRefreshTests } from "./models-auth-status.usage-refresh.test-support.js";

function createOptions(
  params: Record<string, unknown> = {},
  scopes: string[] = ["operator.admin"],
): RespondOptions {
  const respond = vi.fn();
  return {
    req: { type: "req", id: "req-1", method: "models.authStatus", params },
    params,
    client: { connect: { scopes } } as never,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: mocks.getRuntimeConfig } as unknown,
  } as unknown as RespondOptions;
}

const handler = expectDefined(modelsAuthStatusHandlers["models.authStatus"], "auth-status handler");
const logoutHandler = expectDefined(
  modelsAuthStatusHandlers["models.authLogout"],
  "logout handler",
);
const setApiKeyHandler = expectDefined(
  modelsAuthStatusHandlers["models.authSetApiKey"],
  "set-api-key handler",
);
const orderHandler = expectDefined(
  modelsAuthOrderHandlers["models.authOrderSet"],
  "auth-order handler",
);

function mockHealthProvider(provider: AuthHealthSummary["providers"][number], now = 0) {
  mockHealthProviders([provider], now);
}

function mockHealthProviders(providers: AuthHealthSummary["providers"], now = 0) {
  mocks.buildAuthHealthSummary.mockReturnValue({
    now,
    warnAfterMs: 0,
    profiles: providers.flatMap((provider) => provider.profiles),
    providers,
  });
}

async function useRealHealth() {
  const actual = await vi.importActual<typeof import("../../agents/auth-health.js")>(
    "../../agents/auth-health.js",
  );
  mocks.buildAuthHealthSummary.mockImplementation(actual.buildAuthHealthSummary);
}

function createLogoutOptions(params: Record<string, unknown> = {}): RespondOptions {
  const opts = createOptions(params);
  opts.req = { ...opts.req, id: "req-logout", method: "models.authLogout" };
  opts.client = null;
  opts.context = {
    ...opts.context,
    chatRunState: createChatRunState(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
  };
  return opts;
}

function createOrderOptions(params: Record<string, unknown>): RespondOptions {
  const opts = createOptions(params);
  opts.req.method = "models.authOrderSet";
  opts.client = null;
  return opts;
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");
let preparedAuthStore: AuthProfileStore = { version: 1, profiles: {} };
let preparedMetadataSnapshot: unknown;
const isPreparedOwnerCurrent = () => true;

function setPreparedAuthStore(store: RuntimeAuthProfileStore): void {
  preparedAuthStore = store;
  replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: "/tmp/agent", store }]);
}

function setPreparedProfiles(profiles: AuthProfileStore["profiles"]) {
  setPreparedAuthStore(createAuthProfileStoreFixture(profiles));
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
    isCurrent: isPreparedOwnerCurrent,
  };
}

function firstRespondCall(opts: RespondOptions) {
  return opts.respond.mock.calls[0];
}

function expectSuccess(opts: RespondOptions, payload: unknown) {
  expect(firstRespondCall(opts)).toEqual([true, payload, undefined]);
}

function expectInvalid(opts: RespondOptions, details: object) {
  expect(firstRespondCall(opts)).toEqual([
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST", ...details }),
  ]);
}

function expectUnknownAgentId(opts: RespondOptions, agentId: string) {
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

async function readRefreshedUsage() {
  let provider: ModelAuthStatusResult["providers"][number] | undefined;
  await vi.waitFor(
    async () => {
      provider = await firstAuthStatusProvider();
      expect(provider?.usage).toBeDefined();
    },
    { interval: 1 },
  );
  return expectDefined(provider, "refreshed provider");
}

async function warmOAuthUsage() {
  mocks.loadProviderUsageSummary.mockResolvedValue({
    updatedAt: 0,
    providers: [
      { provider: "openai", displayName: "OpenAI", windows: [{ label: "5h", usedPercent: 10 }] },
    ],
  });
  await readAuthStatus({ refreshUsage: true });
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
  mockHealthProviders([]);
  mocks.loadProviderUsageSummary.mockResolvedValue(emptyUsageSummary());
  mocks.refreshActiveProviderAuthRuntimeSnapshot.mockResolvedValue(false);
  vi.spyOn(authProfileSnapshots, "refreshRuntimeAuthProfileStoreSources").mockImplementation(
    mocks.refreshRuntimeAuthProfileStoreSources,
  );
  mocks.refreshRuntimeAuthProfileStoreSources.mockResolvedValue();
  mocks.prepareModelRuntimeSnapshot.mockResolvedValue();
}

function firstDeferredAuthScope() {
  expect(mocks.loadDeferredCatalog).toHaveBeenCalledTimes(1);
  const [, agentId, options] = mocks.loadDeferredCatalog.mock.calls[0] ?? [];
  expect(agentId).toBe("main");
  const deferredOptions = requireRecord(options);
  expect(deferredOptions).toMatchObject({
    readOnly: true,
    refreshAuth: true,
    refreshFullCatalog: false,
  });
  return requireRecord(deferredOptions.authScope);
}

beforeEach(resetAuthStatusMocks);

afterEach(() => {
  vi.restoreAllMocks();
  rpcSourceTesting.clear();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
});

describe("models.authStatus", () => {
  it.each(["retired", "???", "   "])(
    "rejects explicit agent id %j before reading or refreshing auth state",
    async (agentId) => {
      const opts = createOptions({ agentId, refresh: true });
      await handler(opts);
      for (const read of [
        mocks.resolveAgentDir,
        mocks.readPreparedCatalog,
        mocks.loadDeferredCatalog,
        mocks.refreshActiveProviderAuthRuntimeSnapshot,
        mocks.refreshRuntimeAuthProfileStoreSources,
      ]) {
        expect(read).not.toHaveBeenCalled();
      }
      expectUnknownAgentId(opts, agentId);
    },
  );

  it("waits for persisted source refresh before preparing refreshed credentials", async () => {
    const sourceRefresh = createDeferred();
    mocks.refreshRuntimeAuthProfileStoreSources.mockReturnValueOnce(sourceRefresh.promise);
    const pending = readAuthStatus({ refresh: true });

    expect(mocks.refreshRuntimeAuthProfileStoreSources).toHaveBeenCalledOnce();
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadDeferredCatalog).not.toHaveBeenCalled();
    sourceRefresh.resolve();
    await pending;

    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledOnce();
    expect(mocks.loadDeferredCatalog).toHaveBeenCalledOnce();
  });

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
    await Promise.all([admin, reader].map(async (opts) => handler(opts)));

    expect(firstRespondCall(admin)?.[1]?.providers[0]?.profiles[0]).toMatchObject({
      email: "owner@example.com",
      displayName: "Work account",
      lastUsedAt: 42,
      source: "saved",
    });
    const result = firstRespondCall(reader)?.[1] as ModelAuthStatusResult;
    for (const field of ["email", "displayName", "lastUsedAt"]) {
      expect(result.providers[0]?.profiles[0]).not.toHaveProperty(field);
    }
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
    setPreparedProfiles({
      "minimax:global": { type: "token", provider: "minimax", token: "global-token" },
      "minimax:cn": { type: "token", provider: "minimax-cn", token: "cn-token" },
      "anthropic:saved": { type: "token", provider: "anthropic", token: "other-token" },
    });
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
    await useRealHealth();

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
    setPreparedMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "provider-auth",
            origin: "bundled",
            providers: ["OpenAI", "github-copilot", "media-only"],
            providerAuthAliases: { "openai-legacy": "openai" },
            providerAuthChoices: [
              { provider: "openai-legacy", method: "api-key", appGuidedSecret: true },
              { provider: "openai", method: "oauth" },
              {
                provider: "media-only",
                method: "api-key",
                onboardingScopes: ["image-generation" as const],
              },
              { provider: "github-copilot", method: "oauth" },
            ].map(({ provider, method, appGuidedSecret, onboardingScopes }) => ({
              provider,
              method,
              appGuidedSecret,
              onboardingScopes,
              choiceId: `${provider}-${method}`,
              choiceLabel: provider,
            })),
          },
          {
            id: "search-tool",
            setup: { providers: [{ id: "search-tool", authMethods: ["api-key"] }] },
          },
        ],
      }),
    );

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
    await useRealHealth();
    const cli = await import("../../agents/cli-credentials.js");
    const readExternal = vi.spyOn(cli, "readMiniMaxCliCredentialsCached").mockReturnValue(null);
    setPreparedProfiles({
      "minimax-portal:minimax-cli": oauthCredential("minimax-portal", { expires: 1 }),
    });
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
    mockHealthProviders([
      ...["openai", "anthropic", "deepseek"].map(createStaticApiKeyProvider),
      { provider: "openrouter", status: "missing", profiles: [] },
    ]);

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
    await useRealHealth();
    mocks.getRuntimeConfig.mockReturnValue({
      models: {
        providers: {
          anthropic: { apiKey: "ANTHROPIC_API_KEY" },
          openai: { apiKey: NON_ENV_SECRETREF_MARKER },
          ollama: { apiKey: "ollama-local" },
        },
      },
    });

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
    mockHealthProvider({ provider: "anthropic", status: "missing", profiles: [] }, Date.now());
    const result = await readAuthStatus();
    expect(result.providers[0]?.status).toBe("missing");
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
    await readAuthStatus();
    expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
  });

  it("updates expiry labels on cache hits and health at warning and expiry boundaries", async () => {
    await useRealHealth();
    mocks.getRuntimeConfig.mockReturnValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
    });
    const now = 1_000_000;
    const day = 24 * 60 * 60_000;
    const expires = now + 2 * day;
    setPreparedProfiles({
      "anthropic:default": {
        type: "token",
        provider: "anthropic",
        token: "fixture-token",
        expires,
      },
    });
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

  it.each([false, true])(
    "does not publish usage captured before a concurrent logout (refreshUsage=%s)",
    async (refreshUsage) => {
      mocks.removeModelAuthCredentials.mockImplementationOnce(async () => {
        setPreparedAuthStore({ version: 1, profiles: {} });
      });
      const started = createDeferred();
      const usage = createDeferred<UsageSummary>();
      const oauthProfile = healthProfile("openrouter", "oauth", "ok", "openrouter:default");
      mockHealthProvider({ provider: "openrouter", status: "ok", profiles: [oauthProfile] });
      mocks.loadProviderUsageSummary.mockImplementationOnce(() => {
        started.resolve();
        return usage.promise;
      });

      const pending = readAuthStatus({ refreshUsage });
      await started.promise;
      if (!refreshUsage) {
        expect((await pending).providers[0]?.usage).toBeUndefined();
      }
      await logoutHandler(createLogoutOptions({ provider: "openrouter" }));
      usage.resolve({
        updatedAt: 0,
        providers: [
          {
            provider: "openrouter",
            displayName: "OpenRouter",
            windows: [{ label: "day", usedPercent: 99 }],
          },
        ],
      });
      expect((await pending).providers[0]?.usage).toBeUndefined();
      expect((await readAuthStatus()).providers[0]?.usage).toBeUndefined();
      expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
    },
  );

  it.each<{
    source: string;
    usage: UsageSummary["providers"][number];
    expected: NonNullable<ModelAuthStatusResult["providers"][number]["usage"]>;
  }>([
    {
      source: "claude-cli",
      usage: {
        provider: "anthropic",
        displayName: "Claude",
        plan: "Max (20x)",
        accountEmail: "clawd@example.com",
        windows: [{ label: "5h", usedPercent: 22 }],
        billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
      },
      expected: {
        providerId: "anthropic",
        windows: [{ label: "5h", usedPercent: 22 }],
        plan: "Max (20x)",
        accountEmail: "clawd@example.com",
        billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
      },
    },
    {
      source: "deepseek",
      usage: {
        provider: "deepseek",
        displayName: "DeepSeek",
        windows: [],
        summary: "Balance ¥42.50",
      },
      expected: { providerId: "deepseek", windows: [], summary: "Balance ¥42.50" },
    },
  ])(
    "projects $source usage from the selected credential owner",
    async ({ source, usage, expected }) => {
      const config = {};
      mocks.getRuntimeConfig.mockReturnValue(config);
      if (source === "claude-cli") {
        setPreparedMetadataSnapshot(
          createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: "anthropic",
                origin: "bundled",
                providerAuthAliases: { "claude-cli": "anthropic" },
              },
            ],
          }),
        );
        mockHealthProvider({
          provider: source,
          status: "ok",
          profiles: [healthProfile(source, "oauth", "ok", source)],
        });
      } else {
        mockHealthProvider(createStaticApiKeyProvider(source));
      }
      mocks.loadProviderUsageSummary.mockResolvedValue({ updatedAt: 0, providers: [usage] });
      expect((await firstAuthStatusProvider())?.usage).toBeUndefined();
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
        providers: [usage.provider],
        agentDir: "/tmp/agent",
        authStore: preparedAuthStore,
        config,
        timeoutMs: 5_000,
      });
      const refreshed = await readRefreshedUsage();
      expect(refreshed.usage).toEqual(expected);
      if (source === "claude-cli") {
        expect(refreshed).toMatchObject({ displayName: "Claude", authProvider: "anthropic" });
        const reader = createOptions({}, ["operator.read"]);
        await handler(reader);
        expect(firstRespondCall(reader)?.[1]?.providers[0]?.usage).not.toHaveProperty(
          "accountEmail",
        );
      }
    },
  );

  registerModelAuthStatusUsageRefreshTests({
    mocks,
    readAuthStatus,
    warmOAuthUsage,
    createOptions,
  });

  it.each(["directory", "credentials"] as const)(
    "does not reuse usage after the prepared %s changes",
    async (change) => {
      mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
      setPreparedProfiles({
        "openai:default": oauthCredential("openai", {
          access: "first-access",
          refresh: "first-refresh",
        }),
      });
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

    const result = await readAuthStatus();
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
    setPreparedProfiles({
      "openai:one": oauthCredential("openai", { access: "one", refresh: "one-refresh" }),
      "openai:two": oauthCredential("openai", { access: "two", refresh: "two-refresh" }),
    });
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
    expectSuccess(opts, {
      provider: "openai",
      profileIds: null,
      warning: expect.stringContaining("Profile priority saved"),
    });
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

registerModelAuthSetApiKeyTests({ mocks, createOptions, setApiKeyHandler });

registerModelAuthLogoutTests({
  mocks,
  readAuthStatus,
  useRealHealth,
  setPreparedProfiles,
  setPreparedAuthStore,
  createLogoutOptions,
  expectSuccess,
  expectInvalid,
  expectUnknownAgentId,
  oauthCredential,
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
