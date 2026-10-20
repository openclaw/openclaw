import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";

const note = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "agent-default"));
const listAgentIds = vi.hoisted(() =>
  vi.fn((cfg: OpenClawConfig) =>
    cfg.agents?.entries ? Object.keys(cfg.agents.entries) : ["agent-default"],
  ),
);
const resolveAgentDir = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(() => "/tmp/agent-default"),
);
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(() => "/tmp/agent-default/workspace"),
);
const resolveMemorySearchConfig = vi.hoisted(() => vi.fn());
const resolveApiKeyForProviderCore = vi.hoisted(() => vi.fn());
const hasAnyAuthProfileStoreSource = vi.hoisted(() => vi.fn(() => true));
const hasAuthProfileStoreSourceForProvider = vi.hoisted(() => vi.fn(() => true));
const isConfiguredAwsSdkAuthProfileForProvider = vi.hoisted(() => vi.fn(() => false));
const getActiveMemorySearchManagerCore = vi.hoisted(() => vi.fn());
const getActiveMemoryProviderCore = vi.hoisted(() => vi.fn());
const resolveActiveMemoryBackendConfig = vi.hoisted(() => vi.fn());
const noteWorkspaceMemoryHealth = vi.hoisted(() => vi.fn(async () => undefined));
const inspectConfiguredEmbeddingProviderSetup = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForPluginRegistry = vi.hoisted(() =>
  vi.fn<() => PluginManifestRegistry>(() => ({ plugins: [], diagnostics: [] })),
);
const listProviderPolicyOwners = vi.hoisted(() =>
  vi.fn<(provider: string, registry: PluginManifestRegistry) => Array<{ id: string }>>(),
);
const loadProviderPolicyArtifacts = vi.hoisted(() =>
  vi.fn<
    (owners: Array<{ id: string }>) => {
      owner: { id: string };
      surface: {
        inspectEmbeddingProviderSetup: typeof inspectConfiguredEmbeddingProviderSetup;
      } | null;
    } | null
  >(),
);
const resolveManifestOwnerBasePolicyBlock = vi.hoisted(() =>
  vi.fn(
    (_params?: {
      plugin: { id: string };
    }):
      | "plugins-disabled"
      | "blocked-by-denylist"
      | "plugin-disabled"
      | "not-in-allowlist"
      | null => null,
  ),
);
const getMissingLocalMemoryEmbeddingProviderMessage = vi.hoisted(() =>
  vi.fn(
    () =>
      "Unknown memory embedding provider: local.\n" +
      "Local GGUF embeddings are provided by the official llama.cpp provider plugin.\n" +
      "Install it with: openclaw plugins install @openclaw/llama-cpp-provider\n" +
      "Then restart OpenClaw and retry: openclaw memory status --deep",
  ),
);

// mock-isolation: capture Doctor notes without terminal rendering or process state.
vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

// mock-isolation: use a closed synthetic agent inventory for credential scenarios.
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  tryResolveDefaultAgentId: resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
}));

// mock-isolation: inject each scenario's complete memory-search configuration.
vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

// mock-isolation: prevent host credentials and environment keys from entering tests.
vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProviderCore,
  resolveEnvApiKey: vi.fn(() => null),
  resolveUsableCustomProviderApiKey: vi.fn(() => null),
}));

// mock-isolation: model auth-profile availability without reading the host store.
vi.mock("../agents/auth-profiles.js", () => ({
  hasAnyAuthProfileStoreSource,
  hasAuthProfileStoreSourceForProvider,
  isConfiguredAwsSdkAuthProfileForProvider,
}));

// mock-isolation: keep native memory runtime state outside Doctor unit scenarios.
vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemoryProviderCore,
  getActiveMemorySearchManagerCore,
  resolveActiveMemoryBackendConfig,
}));

// mock-isolation: provide a closed plugin registry without loading installed plugins.
vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry,
}));

// mock-isolation: inject the complete owner-policy verdict used by each scenario.
vi.mock("../plugins/manifest-owner-policy.js", () => ({
  resolveManifestOwnerBasePolicyBlock,
}));

// mock-isolation: avoid filesystem-backed provider artifact discovery in unit tests.
vi.mock("../plugins/provider-public-artifacts.js", () => ({
  listProviderPolicyOwners,
  loadProviderPolicyArtifacts,
}));

// mock-isolation: keep bundled runtime loading outside configuration diagnostics.
vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  getMissingLocalMemoryEmbeddingProviderMessage,
}));

vi.mock("./doctor-workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-workspace.js")>();
  return {
    ...actual,
    noteWorkspaceMemoryHealth,
  };
});

import {
  noteMemorySearchHealth,
  collectMemorySearchHealthFindings,
} from "./doctor-memory-search.js";
import { createDoctorNoteAssertions } from "./doctor-memory-search.provider-runtime.test-support.js";

const { firstNoteMessage, expectFirstNoteContains, expectFirstNoteExcludes } =
  createDoctorNoteAssertions(note);

describe("noteMemorySearchHealth", () => {
  const cfg = {} as OpenClawConfig;
  const skippedGatewayOptions = {
    gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
  } satisfies NonNullable<Parameters<typeof noteMemorySearchHealth>[1]>;
  const readyGatewayOptions = {
    gatewayMemoryProbe: { checked: true, ready: true },
  } satisfies NonNullable<Parameters<typeof noteMemorySearchHealth>[1]>;
  const failedGatewayOptions = (error: string) => ({
    gatewayMemoryProbe: { checked: true, ready: false, error },
  });
  const skippedAuthProfileOptions = {
    ...skippedGatewayOptions,
    skipAuthProfileResolution: true,
  } satisfies NonNullable<Parameters<typeof noteMemorySearchHealth>[1]>;
  const openAiEmbeddingModel = { model: "text-embedding-3-small" };
  const bedrockEmbeddingModel = { model: "amazon.titan-embed-text-v2:0" };
  const openAiCompatibleEmbedding = {
    model: "text-embedding-bge-m3",
    remote: { baseUrl: "http://127.0.0.1:1234/v1" },
  };
  type ProviderHealthScenario = [
    string,
    string,
    NonNullable<Parameters<typeof noteMemorySearchHealth>[1]>,
    {
      overrides?: Record<string, unknown>;
      config?: OpenClawConfig;
      contains?: string[];
      noNote?: boolean;
      noApiKeyLookup?: boolean;
    }?,
  ];

  function stubMemorySearchConfig(provider: string, overrides: Record<string, unknown> = {}) {
    resolveMemorySearchConfig.mockReturnValue({
      provider,
      local: {},
      remote: {},
      ...overrides,
    });
  }

  async function runMemorySearchHealth(
    provider: string,
    options?: Parameters<typeof noteMemorySearchHealth>[1],
    overrides?: Record<string, unknown>,
    config: OpenClawConfig = cfg,
  ) {
    stubMemorySearchConfig(provider, overrides);
    await noteMemorySearchHealth(config, options);
  }

  async function runAuthLintHealth(provider: "openai" | "bedrock", config: OpenClawConfig = cfg) {
    await runMemorySearchHealth(
      provider,
      skippedAuthProfileOptions,
      provider === "openai" ? openAiEmbeddingModel : bedrockEmbeddingModel,
      config,
    );
  }

  beforeEach(() => {
    note.mockClear();
    resolveDefaultAgentId.mockClear();
    listAgentIds.mockImplementation((config: OpenClawConfig) =>
      config.agents?.entries ? Object.keys(config.agents.entries) : ["agent-default"],
    );
    resolveAgentDir.mockClear();
    resolveAgentWorkspaceDir.mockClear();
    resolveMemorySearchConfig.mockReset();
    resolveApiKeyForProviderCore.mockReset();
    resolveApiKeyForProviderCore.mockRejectedValue(new Error("missing key"));
    hasAnyAuthProfileStoreSource.mockReset();
    hasAnyAuthProfileStoreSource.mockReturnValue(true);
    hasAuthProfileStoreSourceForProvider.mockReset();
    hasAuthProfileStoreSourceForProvider.mockReturnValue(true);
    isConfiguredAwsSdkAuthProfileForProvider.mockReset();
    isConfiguredAwsSdkAuthProfileForProvider.mockReturnValue(false);
    getActiveMemorySearchManagerCore.mockReset();
    getActiveMemoryProviderCore.mockReset();
    getMissingLocalMemoryEmbeddingProviderMessage.mockClear();
    inspectConfiguredEmbeddingProviderSetup.mockReset();
    inspectConfiguredEmbeddingProviderSetup.mockResolvedValue(null);
    listProviderPolicyOwners.mockReset();
    listProviderPolicyOwners.mockReturnValue([{ id: "llama-cpp" }]);
    loadProviderPolicyArtifacts.mockReset();
    loadProviderPolicyArtifacts.mockImplementation((owners) => {
      const owner = owners[0];
      return owner
        ? {
            owner,
            surface: { inspectEmbeddingProviderSetup: inspectConfiguredEmbeddingProviderSetup },
          }
        : null;
    });
    resolveManifestOwnerBasePolicyBlock.mockReset();
    resolveManifestOwnerBasePolicyBlock.mockReturnValue(null);
    resolveActiveMemoryBackendConfig.mockReset();
    resolveActiveMemoryBackendConfig.mockReturnValue({ backend: "builtin" });
    noteWorkspaceMemoryHealth.mockClear();
  });

  async function collectFindings(config: OpenClawConfig = cfg) {
    return collectMemorySearchHealthFindings({
      mode: "lint",
      cfg: config,
      env: { OPENCLAW_STATE_DIR: "/isolated-memory-state" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
  }

  it.each([
    ["openai", {}, "memory.search.provider"],
    ["openai-compatible", {}, "memory.search.remote.baseUrl"],
    [
      "openai-compatible",
      { remote: { baseUrl: "http://127.0.0.1:1234/v1" } },
      "memory.search.model",
    ],
  ] as const)(
    "reports %s configuration findings with %j at %s",
    async (provider, overrides, path) => {
      stubMemorySearchConfig(provider, overrides);
      hasAuthProfileStoreSourceForProvider.mockReturnValue(false);

      const findings = await collectFindings();

      expect(findings).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/memory-search",
          severity: "warning",
          path,
          fixHint: expect.stringContaining(
            provider === "openai" ? "Then rerun: openclaw doctor" : "Verify:",
          ),
        }),
      ]);
      expect(note).not.toHaveBeenCalled();
      expect(noteWorkspaceMemoryHealth).not.toHaveBeenCalled();
      expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
      expect(getActiveMemorySearchManagerCore).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "does not warn when remote apiKey is configured for explicit provider",
      "openai",
      "from-config",
    ],
    [
      "treats store SecretRef remote apiKey as configured for explicit provider",
      "openai",
      { source: "store", provider: "default", id: "OPENAI_API_KEY" },
    ],
  ])("%s", async (_name, provider, apiKey) => {
    await runMemorySearchHealth(provider, {}, { remote: { apiKey } });
    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "gemini", authProvider: "google", secretId: "GOOGLE_API_KEY", keyKind: "store" },
    { provider: "openai", authProvider: "openai", secretId: "OPENAI_API_KEY", keyKind: "absent" },
    { provider: "openai", authProvider: "openai", secretId: "OPENAI_API_KEY", keyKind: "marker" },
  ] as const)(
    "checks a $keyKind key for $provider",
    async ({ provider, authProvider, secretId, keyKind }) => {
      hasAnyAuthProfileStoreSource.mockReturnValue(false);
      const config: OpenClawConfig = {
        models: {
          providers: {
            [authProvider]: {
              baseUrl: "https://embeddings.example.test/v1",
              models: [],
              apiKey:
                keyKind === "store"
                  ? { source: "store", provider: "default", id: secretId }
                  : keyKind === "marker"
                    ? secretId
                    : undefined,
            },
          },
        },
      };
      await runMemorySearchHealth(provider, undefined, undefined, config);
      if (keyKind === "store") {
        expect(note).not.toHaveBeenCalled();
      } else {
        expect(firstNoteMessage()).toContain("no API key was found");
      }
      expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
    },
  );

  it.each(["none", "ollama"])(
    "explains stopped indexing and recovery with fallback %s",
    async (fallback) => {
      await runMemorySearchHealth("openai", undefined, { fallback });
      expect(note).toHaveBeenCalledTimes(1);
      expectFirstNoteContains(
        "Without working primary or fallback embeddings, memory sync stops for explicitly configured providers or existing vector indexes",
        "new and changed memory files are not indexed",
        "Set OPENAI_API_KEY",
        'set memory.search.provider to "none" for this agent (including any agent override)',
        "openclaw memory index --force --agent agent-default",
        "Then rerun: openclaw doctor",
      );
    },
  );

  it.each([
    ["resolves provider auth from the default agent directory", "gemini", "google", "GEMINI"],
  ])("%s", async (_name, provider, authProvider, envPrefix) => {
    resolveApiKeyForProviderCore.mockResolvedValue({
      apiKey: "k",
      source: `env: ${envPrefix}_API_KEY`,
      mode: "api-key",
    });
    await runMemorySearchHealth(provider);
    expect(resolveApiKeyForProviderCore).toHaveBeenCalledWith({
      provider: authProvider,
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expect(note).not.toHaveBeenCalled();
  });

  it.each<ProviderHealthScenario>([
    [
      "does not warn for ollama when gateway probe is ready without CLI API key",
      "ollama",
      readyGatewayOptions,
      { noNote: true, noApiKeyLookup: true },
    ],
    [
      "warns when lmstudio gateway probe reports embeddings are not ready",
      "lmstudio",
      failedGatewayOptions("LM API token missing"),
      { contains: ['provider "lmstudio" is configured', "embeddings are not ready"] },
    ],
    [
      "does not warn when key-optional provider (ollama) probe was skipped (skipped: true)",
      "ollama",
      skippedGatewayOptions,
      { noNote: true },
    ],
    [
      "does not warn when key-optional provider (openai-compatible) probe was skipped (skipped: true)",
      "openai-compatible",
      skippedGatewayOptions,
      { overrides: openAiCompatibleEmbedding, noNote: true, noApiKeyLookup: true },
    ],
    [
      "warns when openai-compatible is missing its required baseUrl even if probe was skipped",
      "openai-compatible",
      skippedGatewayOptions,
      {
        contains: [
          'provider is set to "openai-compatible"',
          "remote.baseUrl",
          "openclaw config set",
        ],
        noApiKeyLookup: true,
      },
    ],
    [
      "warns when openai-compatible is missing its required model even if probe was skipped",
      "openai-compatible",
      skippedGatewayOptions,
      {
        overrides: { model: "   ", remote: openAiCompatibleEmbedding.remote },
        contains: [
          'provider is set to "openai-compatible"',
          "memory.search.model",
          "openclaw config set",
        ],
        noApiKeyLookup: true,
      },
    ],
    [
      "does not warn for baseUrl-only OpenAI-compatible custom providers when probe was skipped",
      "localEmbeddings",
      skippedGatewayOptions,
      {
        overrides: { model: "text-embedding-bge-m3" },
        config: {
          models: {
            providers: { localEmbeddings: { baseUrl: "http://127.0.0.1:1234/v1", models: [] } },
          },
        } as unknown as OpenClawConfig,
        noNote: true,
        noApiKeyLookup: true,
      },
    ],
  ])("%s", async (_name, provider, options, scenario = {}) => {
    const { overrides, config, contains, noNote, noApiKeyLookup } = scenario;
    await runMemorySearchHealth(provider, options, overrides, config ?? cfg);
    if (noNote) {
      expect(note).not.toHaveBeenCalled();
    }
    if (contains) {
      expect(note).toHaveBeenCalledTimes(1);
      expectFirstNoteContains(...contains);
    }
    if (noApiKeyLookup) {
      expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
    }
  });

  it("does not warn for auth-profile-backed credentials when lint skips profile resolution", async () => {
    await runAuthLintHealth("openai");

    expect(note).not.toHaveBeenCalled();
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
    );
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it.each([
    ["honors configured auth order when lint skips profile resolution", ["openai:expired"]],
    ["warns for explicit empty auth order when lint skips profile resolution", []],
  ])("%s", async (_name, profileIds) => {
    hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
    const orderedCfg = {
      ...cfg,
      auth: { order: { openai: profileIds } },
    } as OpenClawConfig;
    await runAuthLintHealth("openai", orderedCfg);
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
      { profileIds },
    );
    expect(firstNoteMessage()).toContain('provider is set to "openai"');
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("does not warn for Bedrock aws-sdk provider auth when lint skips profile resolution", async () => {
    const bedrockCfg = {
      ...cfg,
      models: {
        providers: {
          "amazon-bedrock": { auth: "aws-sdk", models: [] },
        },
      },
    } as unknown as OpenClawConfig;

    await runAuthLintHealth("bedrock", bedrockCfg);

    expect(note).not.toHaveBeenCalled();
    expect(hasAuthProfileStoreSourceForProvider).not.toHaveBeenCalled();
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("warns for empty auth profile sources when lint skips profile resolution", async () => {
    hasAnyAuthProfileStoreSource.mockReturnValue(true);
    hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
    await runAuthLintHealth("openai");

    expectFirstNoteContains('provider is set to "openai"', "OPENAI_API_KEY");
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
    );
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("does not treat built-in OpenAI as key-optional just because models.providers.openai has baseUrl", async () => {
    const openaiCfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    await runMemorySearchHealth("openai", skippedGatewayOptions, openAiEmbeddingModel, openaiCfg);

    expectFirstNoteContains('provider is set to "openai"', "OPENAI_API_KEY");
    expect(resolveApiKeyForProviderCore).toHaveBeenCalledWith({
      provider: "openai",
      cfg: openaiCfg,
      agentDir: "/tmp/agent-default",
    });
    expect(resolveApiKeyForProviderCore).toHaveBeenCalledOnce();
  });

  it("warns for key-optional provider (lmstudio) when gateway probe timed out", async () => {
    // A gateway timeout sets checked: false but skipped: false/absent. This is a
    // real diagnostic signal — embeddings may be unavailable — so we should warn.
    // Regression guard: https://github.com/openclaw/openclaw/issues/74608
    await runMemorySearchHealth("lmstudio", {
      gatewayMemoryProbe: {
        checked: false,
        ready: false,
        error: "gateway memory check timed out: gateway timeout after 8000ms",
        skipped: false,
      },
    });

    expectFirstNoteContains('provider "lmstudio" is configured');
  });

  it("notes when gateway probe reports embeddings ready and CLI API key is missing", async () => {
    await runMemorySearchHealth("gemini", readyGatewayOptions);

    expectFirstNoteContains("reports memory embeddings are ready");
  });

  it("uses model configure hint when gateway probe is unavailable and API key is missing", async () => {
    await runMemorySearchHealth(
      "gemini",
      failedGatewayOptions("gateway memory probe unavailable: timeout"),
    );

    expectFirstNoteContains(
      "Gateway memory check for default agent is not ready",
      "openclaw configure --section model",
      "GEMINI_API_KEY",
      'provider is set to "gemini"',
    );
    expectFirstNoteExcludes("openclaw auth add --provider");
  });

  it("labels memory readiness failures for a secondary agent", async () => {
    listAgentIds.mockReturnValue(["agent-default", "secondary"]);
    resolveAgentDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}/workspace`);
    resolveMemorySearchConfig.mockImplementation((_cfg, agentId) =>
      agentId === "agent-default" ? { provider: "none", local: {}, remote: {} } : undefined,
    );

    await noteMemorySearchHealth(cfg, { includeWorkspaceMemoryHealth: false });

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toBe(
      'Agent "secondary": Remember across conversations is effectively enabled for agent "secondary", but memory search is disabled. Enable memory search or set memory.search.rememberAcrossConversations to false.',
    );
  });

  it("does not warn for secondary key-optional providers when readiness was skipped", async () => {
    const multiAgentCfg = {
      agents: { entries: { "agent-default": {}, secondary: {} } },
    } as OpenClawConfig;
    resolveAgentDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}/workspace`);
    resolveMemorySearchConfig.mockReturnValue({ provider: "ollama", local: {}, remote: {} });

    await noteMemorySearchHealth(multiAgentCfg, {
      ...skippedGatewayOptions,
      includeWorkspaceMemoryHealth: false,
    });

    expect(note).not.toHaveBeenCalled();
  });
});
