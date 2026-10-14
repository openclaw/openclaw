import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, vi } from "vitest";
import type * as AgentScope from "../../agents/agent-scope.js";
import type * as AuthHealth from "../../agents/auth-health.js";
import type * as AuthProfiles from "../../agents/auth-profiles.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import type * as AuthProfileDisplay from "../../agents/auth-profiles/display.js";
import type * as AuthProfilePaths from "../../agents/auth-profiles/paths.js";
import type * as AuthProfilePersisted from "../../agents/auth-profiles/persisted.js";
import type * as AuthProfileProfiles from "../../agents/auth-profiles/profiles.js";
import type * as AuthProfileStoreRuntime from "../../agents/auth-profiles/store-runtime.js";
import type * as AuthProfileStoreModule from "../../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type * as AuthProfileUsage from "../../agents/auth-profiles/usage.js";
import type * as HarnessRuntime from "../../agents/harness/runtime-plugin.js";
import type * as ModelAuthEnvVars from "../../agents/model-auth-env-vars.js";
import type * as ModelAuthEnv from "../../agents/model-auth-env.js";
import type * as ModelAuth from "../../agents/model-auth.js";
import type * as ModelSelectionCli from "../../agents/model-selection-cli.js";
import type * as OpenAiModelRoutes from "../../agents/openai-model-routes.js";
import type * as PreparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type * as ProviderAuthAliases from "../../agents/provider-auth-aliases.js";
import type * as Workspace from "../../agents/workspace.js";
import type * as ConfigModule from "../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/types.js";
import type * as ProviderUsage from "../../infra/provider-usage.js";
import type * as ShellEnv from "../../infra/shell-env.js";
import type * as PayloadVerification from "../../plugins/payload-verification.js";
import type * as ProviderRuntime from "../../plugins/provider-runtime.js";
import type * as SyntheticAuthRuntime from "../../plugins/synthetic-auth.runtime.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";
import type * as ListProbe from "./list.probe.js";
import { modelsStatusCommand } from "./list.status-command.js";
import type * as LoadConfig from "./load-config.js";

const mocks = vi.hoisted(() => {
  const store: AuthProfileStore = { version: 1, profiles: {} };
  const runtimeStore: { current?: AuthProfileStore } = {};

  return {
    store,
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/openclaw-agent"),
    resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-agent/workspace"),
    resolveDefaultAgentId: vi.fn().mockReturnValue("main"),
    resolveSessionAgentIds: vi.fn(({ agentId }: { agentId?: string } = {}) => ({
      defaultAgentId: "main",
      sessionAgentId: agentId ?? "main",
    })),
    resolveAgentNativeModelPrimary: vi.fn(),
    resolveNativeModelPrimary: vi.fn(),
    resolveAgentModelFallbacksOverride: vi.fn().mockReturnValue(undefined),
    resolveAgentConfig: vi.fn().mockReturnValue(undefined),
    listAgentIds: vi.fn().mockReturnValue(["main", "jeremiah"]),
    listAgentEntries: vi.fn().mockReturnValue([{ id: "main" }, { id: "jeremiah" }]),
    ensureAuthProfileStore: vi.fn().mockReturnValue(store),
    getRuntimeAuthProfileStoreSnapshot: vi.fn(() => runtimeStore.current),
    runtimeStore,
    listProfilesForProvider: vi.fn((s: typeof store, provider: string) => {
      return Object.entries(s.profiles)
        .filter(([, cred]) => cred.provider === provider)
        .map(([id]) => id);
    }),
    loadPersistedAuthProfileStore: vi.fn().mockReturnValue(store),
    resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
    resolveAuthStorePathForDisplay: vi.fn(
      (agentDir?: string) => `${agentDir ?? "/tmp/openclaw-agent"}/auth-profiles.json`,
    ),
    resolveProfileUnusableUntilForDisplay: vi.fn().mockReturnValue(undefined),
    resolveEnvApiKey: vi.fn((provider: string) => {
      if (provider === "openai") {
        return {
          apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "shell env: OPENAI_API_KEY",
        };
      }
      if (provider === "anthropic") {
        return {
          apiKey: "sk-ant-oat01-ACCESS-TOKEN-1234567890", // pragma: allowlist secret
          source: "env: ANTHROPIC_OAUTH_TOKEN",
        };
      }
      return null;
    }),
    resolveProviderEnvAuthLookupMaps: vi.fn().mockReturnValue({
      aliasMap: { "codex-cli": "openai" },
      envCandidateMap: {
        anthropic: ["ANTHROPIC_API_KEY"],
        google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        openai: ["OPENAI_OAUTH_TOKEN", "OPENAI_API_KEY"],
      },
      authEvidenceMap: {},
    }),
    listProviderEnvAuthLookupKeys: vi
      .fn()
      .mockImplementation(() => ["anthropic", "google", "openai", "openai"]),
    listKnownProviderEnvApiKeyNames: vi
      .fn()
      .mockReturnValue([
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_OAUTH_TOKEN",
      ]),
    hasUsableCustomProviderApiKey: vi.fn().mockReturnValue(false),
    resolveUsableCustomProviderApiKey: vi.fn().mockReturnValue(null),
    getCustomProviderApiKey: vi.fn().mockReturnValue(undefined),
    getShellEnvAppliedKeys: vi.fn().mockReturnValue(["OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]),
    shouldEnableShellEnvFallback: vi.fn().mockReturnValue(true),
    createConfigIO: vi.fn().mockReturnValue({
      configPath: "/tmp/openclaw-dev/openclaw.json",
    }),
    loadConfig: vi.fn().mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          models: { "anthropic/claude-opus-4-6": { alias: "Opus" } },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    }),
    loadProviderUsageSummary: vi.fn().mockResolvedValue(undefined),
    runAuthProbes: vi
      .fn<typeof ListProbe.runAuthProbes>()
      .mockImplementation(async ({ options }) => ({
        startedAt: 0,
        finishedAt: 0,
        durationMs: 0,
        totalTargets: 0,
        options,
        results: [],
      })),
    resolveRuntimeSyntheticAuthProviderRefs: vi.fn().mockReturnValue([]),
    resolveProviderSyntheticAuthWithPlugin: vi.fn().mockReturnValue(undefined),
    resolveAgentHarnessOwnerPluginIds: vi.fn().mockReturnValue(["codex"]),
    runPluginPayloadSmokeCheckForManifestRecords: vi
      .fn()
      .mockResolvedValue({ checked: ["codex"], failures: [] }),
    resolveAgentHarnessRuntimeAvailability: vi.fn().mockReturnValue({
      status: "available",
      ownerPluginIds: ["codex"],
    }),
    loadModelCatalog: vi.fn().mockResolvedValue([]),
    modelCatalogRouteVariants: undefined as unknown[] | undefined,
    openAIModelRouteOverride: undefined as ((params: unknown) => unknown) | undefined,
  };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentScope>();
  return {
    ...actual,
    resolveAgentDir: mocks.resolveAgentDir,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
    resolveDefaultAgentId: mocks.resolveDefaultAgentId,
    resolveSessionAgentIds: mocks.resolveSessionAgentIds,
    resolveAgentNativeModelPrimary: mocks.resolveAgentNativeModelPrimary.mockImplementation(
      actual.resolveAgentNativeModelPrimary,
    ),
    resolveNativeModelPrimary: mocks.resolveNativeModelPrimary.mockImplementation(
      actual.resolveNativeModelPrimary,
    ),
    // Raw getters let caller reversions expose the original model-selection leak.
    resolveAgentExplicitModelPrimary: (cfg: OpenClawConfig, agentId: string) =>
      resolveAgentModelPrimaryValue(actual.resolveAgentConfig(cfg, agentId)?.model),
    resolveAgentEffectiveModelPrimary: (cfg: OpenClawConfig, agentId: string) =>
      resolveAgentModelPrimaryValue(actual.resolveAgentConfig(cfg, agentId)?.model) ??
      resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model),
    resolveAgentModelFallbacksOverride: mocks.resolveAgentModelFallbacksOverride,
    resolveAgentConfig: mocks.resolveAgentConfig,
    listAgentIds: mocks.listAgentIds,
    listAgentEntries: mocks.listAgentEntries,
  };
});
vi.mock("../../agents/workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Workspace>()),
  resolveDefaultAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-agent/workspace"),
}));
vi.mock("../../agents/auth-profiles/display.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthProfileDisplay>()),
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
}));
vi.mock("../../agents/auth-profiles/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthProfilePaths>()),
  resolveAuthStorePathForDisplay: mocks.resolveAuthStorePathForDisplay,
}));
vi.mock("../../agents/auth-profiles/persisted.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthProfilePersisted>()),
  loadPersistedAuthProfileStore: mocks.loadPersistedAuthProfileStore,
}));
vi.mock("../../agents/auth-profiles/profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthProfileProfiles>()),
  listProfilesForProvider: mocks.listProfilesForProvider,
}));
vi.mock("../../agents/auth-profiles/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthProfileStoreModule>()),
  getRuntimeAuthProfileStoreSnapshot: mocks.getRuntimeAuthProfileStoreSnapshot,
}));
vi.mock("../../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthProfileStoreRuntime>()),
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles: mocks.ensureAuthProfileStore,
}));
vi.mock("../../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthProfiles>()),
  getRuntimeAuthProfileStoreSnapshot: mocks.getRuntimeAuthProfileStoreSnapshot,
}));
vi.mock("../../agents/auth-profiles/usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthProfileUsage>()),
  resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
}));
vi.mock("../../agents/auth-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthHealth>()),
  DEFAULT_OAUTH_WARN_MS: 86_400_000,
  buildAuthHealthSummary: vi.fn(
    ({ store, warnAfterMs }: { store: typeof mocks.store; warnAfterMs: number }) => {
      const profiles = Object.entries(store.profiles).map(([profileId, profile]) => ({
        profileId,
        provider: profile.provider,
        type: profile.type ?? "api_key",
        status: profile.type === "api_key" ? "static" : "ok",
        source: "store",
        label: profileId,
      }));
      return {
        now: Date.now(),
        warnAfterMs,
        profiles,
        providers: profiles.map((profile) => ({
          provider: profile.provider,
          status: profile.status,
          profiles: [profile],
        })),
      };
    },
  ),
  formatRemainingShort: vi.fn(() => "1h"),
}));
vi.mock("../../agents/model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelAuth>()),
  resolveEnvApiKey: mocks.resolveEnvApiKey,
  hasUsableCustomProviderApiKey: mocks.hasUsableCustomProviderApiKey,
  resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKey,
  getCustomProviderApiKey: mocks.getCustomProviderApiKey,
}));
vi.mock("../../agents/model-auth-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelAuthEnv>()),
  resolveEnvApiKey: mocks.resolveEnvApiKey,
}));
vi.mock("../../agents/model-auth-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelAuthEnvVars>()),
  listProviderEnvAuthLookupKeys: mocks.listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthLookupMaps: mocks.resolveProviderEnvAuthLookupMaps,
  listKnownProviderEnvApiKeyNames: mocks.listKnownProviderEnvApiKeyNames,
}));
vi.mock("../../agents/provider-auth-aliases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderAuthAliases>()),
  resolveProviderAuthAliasMap: vi.fn(() => ({ "codex-cli": "openai" })),
  resolveProviderIdForAuth: vi.fn((provider: string) =>
    provider === "codex-cli" ? "openai" : provider,
  ),
}));
vi.mock("../../agents/model-selection-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelSelectionCli>()),
  isCliProvider: vi.fn((provider: string) => provider === "claude-cli"),
}));
vi.mock("../../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ShellEnv>()),
  getShellEnvAppliedKeys: mocks.getShellEnvAppliedKeys,
  shouldEnableShellEnvFallback: mocks.shouldEnableShellEnvFallback,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  createConfigIO: mocks.createConfigIO,
}));
vi.mock("./list.probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ListProbe>()),
  runAuthProbes: mocks.runAuthProbes,
}));
vi.mock("./load-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LoadConfig>()),
  loadModelsConfig: async () => mocks.loadConfig(),
}));
vi.mock("../../infra/provider-usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderUsage>()),
  formatUsageWindowSummary: vi.fn().mockReturnValue("-"),
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
  resolveUsageProviderId: vi.fn((providerId: string) => providerId),
}));
vi.mock("../../plugins/synthetic-auth.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SyntheticAuthRuntime>()),
  resolveRuntimeSyntheticAuthProviderRefs: mocks.resolveRuntimeSyntheticAuthProviderRefs,
}));
vi.mock("../../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderRuntime>()),
  prepareProviderSyntheticAuthWithPlugin: mocks.resolveProviderSyntheticAuthWithPlugin,
}));
vi.mock("../../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessRuntime>()),
  resolveAgentHarnessOwnerPluginIds: mocks.resolveAgentHarnessOwnerPluginIds,
  resolveAgentHarnessRuntimeAvailability: mocks.resolveAgentHarnessRuntimeAvailability,
}));
vi.mock("../../plugins/payload-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PayloadVerification>()),
  runPluginPayloadSmokeCheckForManifestRecords: mocks.runPluginPayloadSmokeCheckForManifestRecords,
}));
vi.mock("../../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PreparedModelCatalog>()),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await mocks.loadModelCatalog(...args);
    return { entries, routeVariants: mocks.modelCatalogRouteVariants ?? entries };
  },
}));
vi.mock("../../agents/openai-model-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenAiModelRoutes>();
  return {
    ...actual,
    resolveOpenAIModelRoutes: (params: Parameters<typeof actual.resolveOpenAIModelRoutes>[0]) =>
      mocks.openAIModelRouteOverride
        ? mocks.openAIModelRouteOverride(params)
        : actual.resolveOpenAIModelRoutes(params),
    createOpenAIModelRoutesResolver: (
      params: Parameters<typeof actual.createOpenAIModelRoutesResolver>[0],
    ) => {
      const resolveRoutes = actual.createOpenAIModelRoutesResolver(params);
      return (ref: Parameters<ReturnType<typeof actual.createOpenAIModelRoutesResolver>>[0]) =>
        mocks.openAIModelRouteOverride
          ? mocks.openAIModelRouteOverride({ provider: "openai", ...ref })
          : resolveRoutes(ref);
    },
  };
});

const defaultStore: AuthProfileStore = {
  version: 1,
  profiles: {
    "anthropic:default": createOAuthRefreshCredential({
      provider: "anthropic",
      access: "sk-ant-oat01-ACCESS-TOKEN-1234567890",
      refresh: "sk-ant-ort01-REFRESH-TOKEN-1234567890", // pragma: allowlist secret
      email: "peter@example.com",
    }),
    "anthropic:work": createApiKeyCredential(
      "anthropic",
      "sk-ant-api-0123456789abcdefghijklmnopqrstuvwxyz",
    ), // pragma: allowlist secret
    "openai:default": createOAuthRefreshCredential({
      access: "eyJhbGciOi-ACCESS",
      refresh: "oai-refresh-1234567890",
    }),
    "openai:api-key": createApiKeyCredential("openai", "abc123"),
  },
};
Object.assign(mocks.store, structuredClone(defaultStore));
const restoreMocks = Object.values(mocks).flatMap((mock) => {
  if (!vi.isMockFunction(mock)) {
    return [];
  }
  const implementation = mock.getMockImplementation();
  return [
    () => {
      mock.mockReset();
      if (implementation) {
        mock.mockImplementation(implementation);
      }
    },
  ];
});
afterEach(() => {
  for (const restore of restoreMocks) {
    restore();
  }
  for (const key of Object.keys(mocks.store)) {
    Reflect.deleteProperty(mocks.store, key);
  }
  Object.assign(mocks.store, structuredClone(defaultStore));
  mocks.runtimeStore.current = undefined;
  mocks.modelCatalogRouteVariants = undefined;
  mocks.openAIModelRouteOverride = undefined;
});

type StatusOptions = Parameters<typeof modelsStatusCommand>[0];
// Keep command loading behind this fixture's hoisted mocks, including direct-call tests.
function runStatus(...args: Parameters<typeof modelsStatusCommand>) {
  return modelsStatusCommand(...args);
}

async function jsonStatus(options: StatusOptions = {}) {
  const runtime = createTestRuntime();
  await modelsStatusCommand({ json: true, ...options }, runtime);
  return { runtime, payload: JSON.parse(String(runtime.log.mock.calls[0]?.[0])) };
}
async function textStatus(options: StatusOptions = {}) {
  const runtime = createTestRuntime();
  await modelsStatusCommand(options, runtime);
  return { runtime, text: runtime.log.mock.calls.flat().join("\n") };
}

const requireRecord = createRequireRecord("object", "label-not-object");

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error(`${label} was not an array`);
  }
  return value;
}

function requireProvider(providers: unknown, provider: string) {
  const entry = requireArray(providers, "auth providers").find(
    (candidate) => requireRecord(candidate, "auth provider").provider === provider,
  );
  if (!entry) {
    throw new Error(`missing provider ${provider}`);
  }
  return requireRecord(entry, `provider ${provider}`);
}

function expectResolveAgentDirCalledFor(agentId: string) {
  const hasCall = mocks.resolveAgentDir.mock.calls.some((call) => call[1] === agentId);
  expect(hasCall).toBe(true);
}

function configureAgentScope(overrides: {
  primary?: string;
  fallbacks?: string[];
  agentDir?: string;
}) {
  mocks.resolveAgentNativeModelPrimary.mockReturnValue(overrides.primary);
  mocks.resolveNativeModelPrimary.mockReturnValue(overrides.primary);
  mocks.resolveAgentModelFallbacksOverride.mockReturnValue(overrides.fallbacks);
  if (overrides.agentDir) {
    mocks.resolveAgentDir.mockReturnValue(overrides.agentDir);
  }
}

function statusConfig(primary: string, fallbacks: string[] = [], shellEnv = false) {
  return {
    agents: {
      defaults: {
        model: { primary, fallbacks },
        models: Object.fromEntries([primary, ...fallbacks].map((model) => [model, {}])),
      },
    },
    models: { providers: {} },
    env: { shellEnv: { enabled: shellEnv } },
  };
}

function configureStatus(params: {
  primary: string;
  fallbacks?: string[];
  profiles: typeof mocks.store.profiles;
  routeOverride?: (params: unknown) => unknown;
  authOrder?: string[];
  providerBaseUrl?: string;
  providerModels?: ModelDefinitionConfig[];
  catalog?: unknown[];
  routeVariants?: unknown[];
  utilityModel?: string;
  modelPolicyAllow?: string[];
}) {
  const config = statusConfig(params.primary, params.fallbacks);
  mocks.loadConfig.mockReturnValue({
    ...config,
    agents: {
      defaults: {
        ...config.agents.defaults,
        ...(params.modelPolicyAllow ? { modelPolicy: { allow: params.modelPolicyAllow } } : {}),
        utilityModel: params.utilityModel ?? "",
      },
    },
    ...(params.authOrder ? { auth: { order: { openai: params.authOrder } } } : {}),
    models: {
      providers: params.providerBaseUrl
        ? { openai: { baseUrl: params.providerBaseUrl, models: params.providerModels ?? [] } }
        : {},
    },
  });
  mocks.store.profiles = params.profiles;
  mocks.store.order = undefined;
  mocks.resolveEnvApiKey.mockReturnValue(null);
  mocks.openAIModelRouteOverride = params.routeOverride;
  mocks.loadModelCatalog.mockResolvedValue(params.catalog ?? []);
  mocks.modelCatalogRouteVariants = params.routeVariants;
}

export {
  mocks,
  runStatus,
  jsonStatus,
  textStatus,
  requireProvider,
  expectResolveAgentDirCalledFor,
  configureAgentScope,
  statusConfig,
  configureStatus,
};
