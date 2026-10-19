import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import * as openAIModelRoutes from "../../agents/openai-model-routes.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/types.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => {
  const store: AuthProfileStore = { version: 1, profiles: {} };
  const envAuth = new Map([
    [
      "openai",
      {
        apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
        source: "shell env: OPENAI_API_KEY",
      },
    ],
    [
      "anthropic",
      {
        apiKey: "sk-ant-oat01-ACCESS-TOKEN-1234567890", // pragma: allowlist secret
        source: "env: ANTHROPIC_OAUTH_TOKEN",
      },
    ],
  ]);
  const envCandidateMap = {
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    openai: ["OPENAI_OAUTH_TOKEN", "OPENAI_API_KEY"],
  };
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
    resolveAgentModelFallbacksOverride: vi.fn(),
    resolveAgentConfig: vi.fn(),
    listAgentIds: vi.fn().mockReturnValue(["main", "jeremiah"]),
    listAgentEntries: vi.fn().mockReturnValue([{ id: "main" }, { id: "jeremiah" }]),
    ensureAuthProfileStore: vi.fn().mockReturnValue(store),
    getRuntimeAuthProfileStoreSnapshot: vi.fn(),
    loadPersistedAuthProfileStore: vi.fn().mockReturnValue(store),
    resolveAuthStorePathForDisplay: vi.fn(
      (agentDir?: string) => `${agentDir ?? "/tmp/openclaw-agent"}/auth-profiles.json`,
    ),
    resolveProfileUnusableUntilForDisplay: vi.fn(),
    resolveEnvApiKey: vi.fn((provider: string) => envAuth.get(provider) ?? null),
    resolveProviderEnvAuthLookupMaps: vi.fn().mockReturnValue({
      aliasMap: { "codex-cli": "openai" },
      envCandidateMap,
      authEvidenceMap: {},
    }),
    listProviderEnvAuthLookupKeys: vi.fn(() => ["anthropic", "google", "openai", "openai"]),
    listKnownProviderEnvApiKeyNames: vi.fn(() => Object.values(envCandidateMap).flat().toSorted()),
    getShellEnvAppliedKeys: vi.fn().mockReturnValue(["OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]),
    shouldEnableShellEnvFallback: vi.fn().mockReturnValue(true),
    createConfigIO: vi.fn(() => ({ configPath: "/tmp/openclaw-dev/openclaw.json" })),
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
      .fn<typeof import("./list.probe.js").runAuthProbes>()
      .mockImplementation(async ({ options }) => ({
        startedAt: 0,
        finishedAt: 0,
        durationMs: 0,
        totalTargets: 0,
        options,
        results: [],
      })),
    resolveRuntimeSyntheticAuthProviderRefs: vi.fn().mockReturnValue([]),
    resolveProviderSyntheticAuthWithPlugin: vi.fn(),
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
  };
});

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await import("../../agents/agent-scope-config.js");
  const { resolveAgentModelPrimaryValue } = await import("../../config/model-input.js");
  return {
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
vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/openclaw-agent/workspace"),
}));
vi.mock("../../agents/auth-profiles/paths.js", () => ({
  resolveAuthStorePathForDisplay: mocks.resolveAuthStorePathForDisplay,
}));
vi.mock("../../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: mocks.loadPersistedAuthProfileStore,
}));
vi.mock("../../agents/auth-profiles/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/store.js")>()),
  getRuntimeAuthProfileStoreSnapshot: mocks.getRuntimeAuthProfileStoreSnapshot,
}));
vi.mock("../../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/store-runtime.js")>()),
  ensureAuthProfileStoreAsync: async (...args: unknown[]) => mocks.ensureAuthProfileStore(...args),
  ensureAuthProfileStoreWithoutExternalProfilesAsync: async (...args: unknown[]) =>
    mocks.ensureAuthProfileStore(...args),
}));
vi.mock("../../agents/auth-profiles/usage.js", () => ({
  resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
}));
vi.mock("../../agents/model-auth-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-auth-env.js")>()),
  resolveEnvApiKey: mocks.resolveEnvApiKey,
}));
vi.mock("../../agents/model-auth-env-vars.js", () => ({
  listProviderEnvAuthLookupKeys: mocks.listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthLookupMaps: mocks.resolveProviderEnvAuthLookupMaps,
  listKnownProviderEnvApiKeyNames: mocks.listKnownProviderEnvApiKeyNames,
}));
vi.mock("../../agents/provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: vi.fn(() => ({ "codex-cli": "openai" })),
  resolveProviderIdForAuth: vi.fn((provider: string) =>
    provider === "codex-cli" ? "openai" : provider,
  ),
}));
vi.mock("../../agents/model-selection-cli.js", () => ({
  isCliProvider: vi.fn((provider: string) => provider === "claude-cli"),
}));
vi.mock("../../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: mocks.getShellEnvAppliedKeys,
  shouldEnableShellEnvFallback: mocks.shouldEnableShellEnvFallback,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  createConfigIO: mocks.createConfigIO,
}));
vi.mock("./list.probe.js", () => ({ runAuthProbes: mocks.runAuthProbes }));
vi.mock("./load-config.js", () => ({
  loadModelsConfig: async () => mocks.loadConfig(),
}));
vi.mock("../../infra/provider-usage.js", () => ({
  formatUsageWindowSummary: vi.fn().mockReturnValue("-"),
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
  resolveUsageProviderId: vi.fn((providerId: string) => providerId),
}));
vi.mock("../../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: mocks.resolveRuntimeSyntheticAuthProviderRefs,
}));
vi.mock("../../plugins/provider-runtime.js", () => ({
  prepareProviderSyntheticAuthWithPlugin: mocks.resolveProviderSyntheticAuthWithPlugin,
}));
vi.mock("../../agents/harness/runtime-plugin.js", () => ({
  resolveAgentHarnessOwnerPluginIds: mocks.resolveAgentHarnessOwnerPluginIds,
  resolveAgentHarnessRuntimeAvailability: mocks.resolveAgentHarnessRuntimeAvailability,
}));
vi.mock("../../plugins/payload-verification.js", () => ({
  runPluginPayloadSmokeCheckForManifestRecords: mocks.runPluginPayloadSmokeCheckForManifestRecords,
}));
vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await mocks.loadModelCatalog(...args);
    return { entries, routeVariants: mocks.modelCatalogRouteVariants ?? entries };
  },
}));

import { modelsStatusCommand } from "./list.status-command.js";

const defaultStore: AuthProfileStore = {
  version: 1,
  profiles: {
    "anthropic:default": createOAuthRefreshCredential({
      provider: "anthropic",
      email: "peter@example.com",
    }),
    "anthropic:work": createApiKeyCredential("anthropic", "test-key"),
    "openai:default": createOAuthRefreshCredential(),
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
  vi.restoreAllMocks();
  for (const restore of restoreMocks) {
    restore();
  }
  for (const key of Object.keys(mocks.store)) {
    Reflect.deleteProperty(mocks.store, key);
  }
  Object.assign(mocks.store, structuredClone(defaultStore));
  mocks.modelCatalogRouteVariants = undefined;
});

type StatusOptions = Parameters<typeof modelsStatusCommand>[0];
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
async function failingStatus() {
  const json = await jsonStatus({ check: true });
  const text = await textStatus({ check: true });
  for (const { runtime } of [json, text]) {
    expect(runtime.exit).toHaveBeenCalledWith(1);
  }
  return { payload: json.payload, text: text.text };
}

it("keeps configured model controls out of text status while preserving JSON", async () => {
  const primary = "anthropic/claude-sonnet-4-6";
  const alias = "café\u001b[2J\nforged";
  const fallback = "anthropic/fallback\u001b[2J\nforged";
  mocks.loadConfig.mockReturnValue(
    statusConfig(primary, [fallback], false, {
      models: { [primary]: { alias }, [fallback]: {} },
      imageModel: { primary: "openai/image", fallbacks: [fallback] },
      utilityModel: "",
    }),
  );
  const { text } = await textStatus();
  expect(text).toContain("café\\nforged");
  expect(text).toContain("anthropic/fallback\\nforged");
  expect(text).not.toContain("\u001b[2J");
  expect(text).not.toContain("\nforged");
  const { payload } = await jsonStatus();
  expect(payload.aliases[alias]).toBe(primary);
  expect(payload.fallbacks).toEqual([fallback]);
});

function codexRoute(
  status: string,
  effective = { kind: "profiles", detail: "/tmp/openclaw-agent/auth-profiles.json" },
) {
  return { provider: "openai", runtime: "codex", authProvider: "openai", status, effective };
}

function expectResolveAgentDirCalledFor(agentId: string) {
  expect(mocks.resolveAgentDir.mock.calls.some((call) => call[1] === agentId)).toBe(true);
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

function configureAgents(
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>,
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  ownership?: "explicit",
) {
  mocks.loadConfig.mockReturnValue({ agents: { defaults, entries, ownership } });
}

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
function statusConfig(
  primary: string,
  fallbacks: string[] = [],
  shellEnv = false,
  defaults: Partial<AgentDefaults> = {},
) {
  return {
    agents: {
      defaults: {
        model: { primary, fallbacks },
        models: Object.fromEntries([primary, ...fallbacks].map((model) => [model, {}])),
        ...defaults,
      },
    },
    models: { providers: {} },
    env: { shellEnv: { enabled: shellEnv } },
  };
}

function configureStatus(params: {
  primary: string;
  fallbacks?: string[];
  profiles?: typeof mocks.store.profiles;
  authOrder?: string[];
  providerBaseUrl?: string;
  providerModels?: ModelDefinitionConfig[];
  catalog?: unknown[];
  routeVariants?: unknown[];
  utilityModel?: AgentModelConfig;
  modelPolicyAllow?: string[];
}) {
  mocks.loadConfig.mockReturnValue({
    ...statusConfig(params.primary, params.fallbacks, false, {
      ...(params.modelPolicyAllow ? { modelPolicy: { allow: params.modelPolicyAllow } } : {}),
      utilityModel: params.utilityModel ?? "",
    }),
    ...(params.authOrder ? { auth: { order: { openai: params.authOrder } } } : {}),
    models: {
      providers: params.providerBaseUrl
        ? { openai: { baseUrl: params.providerBaseUrl, models: params.providerModels ?? [] } }
        : {},
    },
  });
  mocks.store.profiles = params.profiles ?? {};
  mocks.store.order = undefined;
  mocks.resolveEnvApiKey.mockReturnValue(null);
  mocks.loadModelCatalog.mockResolvedValue(params.catalog ?? []);
  mocks.modelCatalogRouteVariants = params.routeVariants;
}

describe("modelsStatusCommand auth overview", () => {
  it.each([
    {
      profileId: "anthropic:default",
      usage: { cooldownReason: "session_expired" as const },
      expected: {
        kind: "cooldown",
        reason: "session_expired",
        recoveryHint:
          "Re-authenticate with `openclaw models auth login --provider anthropic --profile-id 'anthropic:default'`.",
      },
      text: [
        "Unavailable auth profiles",
        "anthropic:default (anthropic) cooldown:session_expired",
        "openclaw models auth login --provider anthropic",
      ],
    },
    {
      profileId: "openai:default",
      usage: {
        cooldownReason: "auth" as const,
        cooldownClassification: "wham_token_expired" as const,
      },
      expected: { reason: "auth", classification: "wham_token_expired" },
      text: ["cooldown:wham_token_expired"],
    },
  ])(
    "reports cooldown diagnostics and recovery for $profileId",
    async ({ profileId, usage, expected, text }) => {
      const until = Date.now() + 60_000;
      mocks.store.usageStats = { [profileId]: { cooldownUntil: until, ...usage } };
      mocks.resolveProfileUnusableUntilForDisplay.mockImplementation((_store, id) =>
        id === profileId ? until : undefined,
      );
      const { payload } = await jsonStatus();
      expect(payload.auth.unusableProfiles).toEqual([
        expect.objectContaining({ profileId, ...expected }),
      ]);
      const result = await textStatus();
      for (const line of text) {
        expect(result.text).toContain(line);
      }
    },
  );

  it("keeps status metadata scoped while another operation publishes metadata", async () => {
    const scope = {
      config: mocks.loadConfig(),
      workspaceDir: "/tmp/openclaw-agent/workspace",
      env: process.env,
    };
    const catalogStarted = createDeferred();
    const releaseCatalog = createDeferred();
    let replacement: ReturnType<typeof getCurrentPluginMetadataSnapshot> = undefined;
    clearPluginMetadataLifecycleCaches();
    mocks.loadModelCatalog.mockImplementationOnce(async () => {
      replacement = getCurrentPluginMetadataSnapshot(scope);
      catalogStarted.resolve();
      await releaseCatalog.promise;
      return [];
    });
    const commandPromise = modelsStatusCommand({ json: true }, createTestRuntime());

    try {
      await catalogStarted.promise;
      expect(replacement).toBeDefined();
      expect(getCurrentPluginMetadataSnapshot(scope)).toBeUndefined();
      clearPluginMetadataLifecycleCaches();
      setCurrentPluginMetadataSnapshot(replacement!, scope);
      releaseCatalog.resolve();
      await commandPromise;

      expect(getCurrentPluginMetadataSnapshot(scope)).toBe(replacement);
    } finally {
      releaseCatalog.resolve();
      await commandPromise.catch(() => {});
      clearPluginMetadataLifecycleCaches();
    }
  });

  it("rejects a non-integer probe concurrency", async () => {
    const localRuntime = createTestRuntime();
    mocks.runAuthProbes.mockClear();
    await expect(
      modelsStatusCommand({ json: true, probe: true, probeConcurrency: "2.5" }, localRuntime),
    ).rejects.toThrow("--probe-concurrency");
    expect(mocks.runAuthProbes).not.toHaveBeenCalled();
    expect(localRuntime.log).not.toHaveBeenCalled();
  });

  it("forwards probe numeric options", async () => {
    await jsonStatus({
      probe: true,
      probeTimeout: "1.5",
      probeConcurrency: "1",
      probeMaxTokens: "1",
    });
    expect(mocks.runAuthProbes).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        options: expect.objectContaining({ timeoutMs: 1.5, concurrency: 1, maxTokens: 1 }),
      }),
    );
  });

  it.each([
    {
      name: "expands nested wildcard matches",
      primary: "clawrouter/anthropic/claude-haiku-4-5",
      catalog: [
        "clawrouter/anthropic/claude-haiku-4-5",
        "clawrouter/google/gemini-3.5-flash",
        "openai/gpt-5.6-sol",
      ],
      allowed: ["clawrouter/anthropic/claude-haiku-4-5"],
    },
    {
      name: "preserves restrictive wildcards without a catalog match",
      primary: "openai/gpt-5.6-sol",
      catalog: ["openai/gpt-5.6-sol"],
      allowed: ["clawrouter/anthropic/*"],
    },
  ])("$name", async ({ primary, catalog, allowed }) => {
    configureStatus({
      primary,
      modelPolicyAllow: ["clawrouter/anthropic/*"],
      catalog: catalog.map((ref) => {
        const slash = ref.indexOf("/");
        return { provider: ref.slice(0, slash), id: ref.slice(slash + 1), name: ref };
      }),
    });
    const { payload } = await jsonStatus();
    expect(JSON.stringify(payload.auth)).not.toContain("abc123");
    expect(payload.allowed).toEqual(allowed);
  });

  it("honors OPENCLAW_AGENT_DIR when no --agent override is provided", async () => {
    const { payload } = await withEnvAsync(
      { OPENCLAW_AGENT_DIR: "/tmp/openclaw-isolated-agent" },
      () => jsonStatus(),
    );

    expectResolveAgentDirCalledFor("main");
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-isolated-agent");
    expect(payload).toMatchObject({
      agentDir: "/tmp/openclaw-isolated-agent",
      auth: { storePath: "/tmp/openclaw-isolated-agent/auth-profiles.json" },
    });
  });

  it("uses agent overrides and reports sources", async () => {
    configureAgentScope({
      primary: "openai/gpt-4",
      fallbacks: ["openai/gpt-3.5"],
      agentDir: "/tmp/openclaw-agent-custom",
    });

    const { payload } = await jsonStatus({ agent: "Jeremiah" });
    expectResolveAgentDirCalledFor("jeremiah");
    expect(payload).toMatchObject({
      agentId: "jeremiah",
      agentDir: "/tmp/openclaw-agent-custom",
      defaultModel: "openai/gpt-4",
      fallbacks: ["openai/gpt-3.5"],
      modelConfig: { defaultSource: "agent", fallbacksSource: "agent" },
      auth: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "openai",
            effective: {
              kind: "profiles",
              detail: "/tmp/openclaw-agent-custom/auth-profiles.json",
            },
          }),
        ]),
      },
    });
  });

  it("resolves model aliases in the selected agent scope", async () => {
    configureAgents(
      {
        model: { primary: "openai/gpt-default", fallbacks: [] },
        models: { "openai/gpt-shared": { alias: "shared" } },
      },
      {
        jeremiah: {
          model: { primary: "shared" },
          models: { "anthropic/claude-sonnet-4-6": { alias: "shared" } },
        },
      },
    );

    const { payload } = await jsonStatus({ agent: "jeremiah" });
    expect(payload).toMatchObject({
      defaultModel: "shared",
      resolvedDefault: "anthropic/claude-sonnet-4-6",
      aliases: { shared: "anthropic/claude-sonnet-4-6" },
    });
  });

  it("uses system-agent storage without changing unscoped model output", async () => {
    configureAgents(
      {
        model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
        systemAgent: { agentId: "jeremiah" },
      },
      { main: {}, jeremiah: {} },
      "explicit",
    );
    configureAgentScope({ primary: "openai/gpt-5.6-luna", fallbacks: ["openai/gpt-5.6-sol"] });

    const { payload } = await jsonStatus();
    expectResolveAgentDirCalledFor("jeremiah");
    expect(mocks.resolveAgentNativeModelPrimary).not.toHaveBeenCalled();
    expect(mocks.loadModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "jeremiah", readOnly: true }),
    );
    expect(payload).toMatchObject({
      defaultModel: "anthropic/claude-opus-4-6",
      fallbacks: [],
    });
  });

  it("rejects API-key auth for subscription-only Codex Spark", async () => {
    configureStatus({
      primary: "openai/gpt-5.3-codex-spark",
      profiles: {
        "openai:api-key": createApiKeyCredential("openai", "sk-openai-platform-only"),
      },
    });

    const { payload, text } = await failingStatus();
    expect(payload.auth.missingProvidersInUse).toEqual(["openai"]);
    expect(payload.auth.runtimeAuthRoutes).toEqual([
      codexRoute("missing", { kind: "missing", detail: "missing" }),
    ]);
    expect(text).not.toContain("set an API key env var");
  });

  it("reports usable Codex auth as unavailable when its harness plugin is quarantined", async () => {
    const payloadFailure = {
      pluginId: "codex",
      installPath: "/private/plugin",
      reason: "missing-package-dir" as const,
      detail: "missing",
    };
    mocks.runPluginPayloadSmokeCheckForManifestRecords
      .mockResolvedValueOnce({ checked: ["codex"], failures: [payloadFailure] })
      .mockResolvedValueOnce({ checked: ["codex"], failures: [payloadFailure] });
    const resolveAvailability = (params: {
      payloadFailures: Array<{ pluginId: string; reason: string }>;
    }) =>
      params.payloadFailures.some((failure) => failure.pluginId === "codex")
        ? {
            status: "unavailable",
            ownerPluginIds: ["codex", "openai"],
            reason: "owner-plugin-degraded",
            detail:
              'Agent harness "codex" owner plugin "codex" is unavailable (missing-package-dir).',
          }
        : { status: "available", ownerPluginIds: ["codex", "openai"] };
    mocks.resolveAgentHarnessRuntimeAvailability
      .mockImplementationOnce(resolveAvailability)
      .mockImplementationOnce(resolveAvailability);
    configureStatus({
      primary: "openai/gpt-5.5",
      profiles: { "openai:default": createOAuthRefreshCredential() },
    });

    const { payload, text } = await failingStatus();

    expect(mocks.runPluginPayloadSmokeCheckForManifestRecords).toHaveBeenCalledWith(
      expect.objectContaining({ env: process.env }),
    );
    expect(mocks.resolveAgentHarnessRuntimeAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "codex",
        provider: "openai",
        payloadFailures: [payloadFailure],
        payloadCheckedPluginIds: ["codex"],
        selectedPluginRootDirs: expect.any(Map),
      }),
    );
    expect(payload.auth.runtimeAuthRoutes).toEqual([
      {
        ...codexRoute("unavailable"),
        authStatus: "usable",
        runtimeStatus: "unavailable",
        runtimeReason: "owner-plugin-degraded",
        runtimeDetail:
          'Agent harness "codex" owner plugin "codex" is unavailable (missing-package-dir).',
        runtimePluginIds: ["codex", "openai"],
      },
    ]);
    for (const part of ["status=unavailable", "auth=usable", "runtime=unavailable"]) {
      expect(text).toContain(part);
    }
  });

  it("flags a utility fallback whose route needs api-key auth despite an OAuth-healthy primary", async () => {
    configureStatus({
      primary: "openai/gpt-5.5",
      utilityModel: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.6"] },
      profiles: { "openai:default": createOAuthRefreshCredential() },
    });

    const { payload } = await jsonStatus({ check: true });
    expect(payload.utilityModel).toEqual({ ref: "openai/gpt-5.5", source: "config" });
    expect(payload.utilityFallbacks).toEqual(["openai/gpt-5.6"]);
    expect(payload.auth.modelRouteIssues).toEqual([
      {
        kind: "missing-auth",
        provider: "openai",
        model: "gpt-5.6",
        authRequirement: "api-key",
        message: "No usable api-key authentication is available for openai/gpt-5.6.",
      },
    ]);
  });

  it("reports incompatible model routes separately in JSON and text", async () => {
    const incompatibility = {
      kind: "incompatible" as const,
      code: "platform-only-model-on-chatgpt",
      message: "gpt-5.6 is available only through OpenAI Platform API-key authentication.",
    };
    vi.spyOn(openAIModelRoutes, "resolveOpenAIModelRoutes").mockReturnValue(incompatibility);
    vi.spyOn(openAIModelRoutes, "createOpenAIModelRoutesResolver").mockReturnValue(
      () => incompatibility,
    );
    configureStatus({ primary: "openai/gpt-5.6" });

    const { payload, text } = await failingStatus();
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([
      {
        ...incompatibility,
        provider: "openai",
        model: "gpt-5.6",
      },
    ]);
    for (const part of [
      "openai/gpt-5.6",
      "platform-only-model-on-chatgpt",
      "available only through OpenAI Platform API-key authentication",
    ]) {
      expect(text).toContain(part);
    }
  });

  it("selects ChatGPT nano when grouped physical routes put Platform first", async () => {
    const platform = {
      id: "gpt-5.4-nano",
      name: "Platform Nano",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const chatGPT = {
      id: "openai/gpt-5.4-nano",
      name: "ChatGPT Nano",
      provider: "openai",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    configureStatus({
      primary: "openai/gpt-5.4-nano",
      profiles: {
        "openai:subscription": createOAuthRefreshCredential({ expires: Date.now() + 10 * 60_000 }),
      },
      authOrder: ["openai:subscription"],
      catalog: [platform],
      routeVariants: [platform, chatGPT],
    });

    const { runtime: localRuntime, payload } = await jsonStatus({ check: true });

    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([]);
    expect(localRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("keeps model status independent of differently cased routes", async () => {
    const responsesId = "rEaDeR";
    const baseUrl = "https://models.example.test/v1";
    const model = (id: string, api?: ModelDefinitionConfig["api"]): ModelDefinitionConfig => ({
      id,
      name: id,
      api,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    });
    const providerModels = [
      model("Reader", "openai-completions"),
      model(responsesId, "openai-responses"),
      model("reader"),
    ];
    const catalog = providerModels.map((entry) => ({ ...entry, provider: "openai", baseUrl }));
    const fallbacks = [`openai/${responsesId}`, "openai/reader"];
    configureStatus({
      primary: "openai/Reader",
      fallbacks,
      profiles: {
        "openai:default": createApiKeyCredential("openai", "status-proof"),
      },
      providerBaseUrl: baseUrl,
      providerModels,
      catalog,
      routeVariants: catalog,
    });

    const { runtime: localRuntime, payload } = await jsonStatus({ check: true });

    expect(payload).toMatchObject({
      defaultModel: "openai/Reader",
      fallbacks,
      auth: { modelRouteIssues: [], missingProvidersInUse: [], runtimeAuthRoutes: [] },
    });
    expect(localRuntime.exit).toHaveBeenCalledWith(0);
  });

  it("reports unresolved API-key SecretRef profiles as indeterminate", async () => {
    configureStatus({
      primary: "openai/gpt-5.6",
      profiles: {
        "openai:ref": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });
    const { runtime: localRuntime, payload } = await withEnvAsync(
      { OPENAI_API_KEY: undefined },
      () => jsonStatus({ check: true }),
    );
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([
      expect.objectContaining({
        kind: "indeterminate",
        provider: "openai",
        model: "gpt-5.6",
        evidence: "profile",
      }),
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("handles cli backend and exact provider auth summaries", async () => {
    mocks.loadConfig.mockReturnValue(statusConfig("claude-cli/claude-sonnet-4-6", [], true));
    mocks.resolveEnvApiKey.mockImplementation(() => null);

    const { payload } = await jsonStatus();
    expect(payload.defaultModel).toBe("claude-cli/claude-sonnet-4-6");
    expect(payload.auth.missingProvidersInUse).toStrictEqual([]);

    mocks.loadConfig.mockReturnValue({
      ...statusConfig("z.ai/glm-4.7", [], true),
      models: { providers: { "z.ai": {} } },
    });
    mocks.resolveEnvApiKey.mockImplementation((provider: string) => {
      if (provider === "zai" || provider === "z.ai" || provider === "z-ai") {
        return {
          apiKey: "sk-zai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "shell env: ZAI_API_KEY",
        };
      }
      return null;
    });
    const { payload: aliasPayload } = await jsonStatus();
    const providers = aliasPayload.auth.providers as Array<{ provider: string }>;
    expect(
      providers.reduce((count, provider) => count + (provider.provider === "z.ai" ? 1 : 0), 0),
    ).toBe(1);
    expect(providers.map((provider) => provider.provider)).not.toContain("zai");
  });

  it("treats plugin-owned synthetic auth as usable for models in use", async () => {
    mocks.loadConfig.mockReturnValue(statusConfig("codex/gpt-5.5"));
    mocks.resolveEnvApiKey.mockImplementation(() => null);
    mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue(["codex", "unused-synthetic"]);
    mocks.resolveProviderSyntheticAuthWithPlugin.mockImplementation(
      ({ provider }: { provider: string }) =>
        provider === "codex"
          ? {
              apiKey: "codex-runtime-token",
              source: "codex-app-server",
              mode: "token",
              expiresAt: Date.now() + 60_000,
            }
          : undefined,
    );

    const syntheticProbeStart = mocks.resolveProviderSyntheticAuthWithPlugin.mock.calls.length;
    const { payload } = await jsonStatus();
    const syntheticProbeProviders = mocks.resolveProviderSyntheticAuthWithPlugin.mock.calls
      .slice(syntheticProbeStart)
      .map(([arg]) => (arg as { provider: string }).provider);
    expect(payload.auth.missingProvidersInUse).toStrictEqual([]);
    expect(payload.auth.providers).toContainEqual(
      expect.objectContaining({
        provider: "codex",
        syntheticAuth: { value: "plugin-owned", source: "codex-app-server" },
        effective: { kind: "synthetic", detail: "codex-app-server" },
      }),
    );
    expect(JSON.stringify(payload)).not.toContain("codex-runtime-token");
    expect(syntheticProbeProviders).toStrictEqual(["codex"]);
    expect(payload.auth.providers).not.toContainEqual(
      expect.objectContaining({ provider: "unused-synthetic" }),
    );
  });

  it("does not treat declared but unresolved synthetic auth as usable", async () => {
    mocks.loadConfig.mockReturnValue(statusConfig("codex/gpt-5.5"));
    mocks.store.profiles = {};
    mocks.resolveEnvApiKey.mockImplementation(() => null);
    mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue(["codex"]);
    mocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue(undefined);

    const { runtime: localRuntime, payload } = await jsonStatus({ check: true });
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([
      expect.objectContaining({ kind: "indeterminate", provider: "codex" }),
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("reports and probes native defaults with a separate harness model", async () => {
    const primary = "anthropic/claude-opus-4-6";
    const fallbacks = ["anthropic/claude-sonnet-4-6"];
    configureAgents(
      { model: { primary, fallbacks }, utilityModel: "" },
      {
        main: {
          model: "openai/gpt-5.4",
          runtime: { type: "acp", acp: { agent: "cursor" } },
        },
      },
    );

    const { text: output } = await textStatus({ agent: "main" });

    const { payload } = await jsonStatus({ probe: true, agent: "main" });
    expect(mocks.runAuthProbes).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelCandidates: [primary, ...fallbacks] }),
    );
    expect(payload).toMatchObject({
      defaultModel: primary,
      resolvedDefault: primary,
      fallbacks,
      modelConfig: { defaultSource: "defaults", fallbacksSource: "defaults" },
    });
    expect(output).toContain("Default (defaults)");
    expect(output).toContain(`Fallbacks (${fallbacks.length}) (defaults)`);
    expect(mocks.ensureAuthProfileStore).toHaveBeenLastCalledWith("/tmp/openclaw-agent");
  });

  it("exits non-zero when auth is missing", async () => {
    mocks.store.profiles = {};
    const localRuntime = {
      ...createTestRuntime(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };

    mocks.resolveEnvApiKey.mockImplementation(() => null);

    await modelsStatusCommand({ check: true, plain: true }, localRuntime);
    expect(localRuntime.writeStdout).toHaveBeenCalledOnce();
    expect(localRuntime.log).not.toHaveBeenCalled();
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
  });
});
