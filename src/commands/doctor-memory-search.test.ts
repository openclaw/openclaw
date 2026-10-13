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

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  tryResolveDefaultAgentId: resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProviderCore,
  resolveEnvApiKey: vi.fn(() => null),
  resolveUsableCustomProviderApiKey: vi.fn(() => null),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  hasAnyAuthProfileStoreSource,
  hasAuthProfileStoreSourceForProvider,
  isConfiguredAwsSdkAuthProfileForProvider,
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemoryProviderCore,
  getActiveMemorySearchManagerCore,
  resolveActiveMemoryBackendConfig,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry,
}));

vi.mock("../plugins/manifest-owner-policy.js", () => ({
  resolveManifestOwnerBasePolicyBlock,
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  listProviderPolicyOwners,
  loadProviderPolicyArtifacts,
}));

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
import {
  createDoctorNoteAssertions,
  registerProviderRuntimeDoctorTest,
} from "./doctor-memory-search.provider-runtime.test-support.js";

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
  const sessionMemory = {
    sources: ["memory", "sessions"],
    experimental: { sessionMemory: true },
  };
  const conversationRecall = {
    ...sessionMemory,
    rememberAcrossConversations: true,
  };
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

  function conversationRecallConfig(plugins?: OpenClawConfig["plugins"]): OpenClawConfig {
    return {
      agents: {
        entries: {
          personal: {
            memory: { search: { rememberAcrossConversations: true } },
          },
        },
      },
      ...(plugins ? { plugins } : {}),
    } as OpenClawConfig;
  }

  async function runConversationRecallHealth(plugins?: OpenClawConfig["plugins"]) {
    await runMemorySearchHealth(
      "none",
      undefined,
      conversationRecall,
      conversationRecallConfig(plugins),
    );
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

  registerProviderRuntimeDoctorTest({
    cfg,
    stubMemorySearchConfig,
    noteMemorySearchHealth,
    expectFirstNoteContains,
  });

  it("preserves disabled-memory lint filtering with multiple agents", async () => {
    const config = {
      agents: {
        entries: Object.fromEntries(
          ["personal", "secondary"].map((id) => [
            id,
            { memory: { search: { rememberAcrossConversations: false } } },
          ]),
        ),
      },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue(undefined);

    const findings = await collectFindings(config);

    expect(findings.map(({ message, path }) => ({ message, path }))).toEqual([
      {
        message: 'Agent "personal": Memory search is explicitly disabled (enabled: false).',
        path: "memory.search.provider",
      },
      {
        message: 'Agent "secondary": Memory search is explicitly disabled (enabled: false).',
        path: "memory.search.provider",
      },
    ]);
  });

  it("emits recall warnings before a later provider diagnostic fails", async () => {
    stubMemorySearchConfig("local");
    inspectConfiguredEmbeddingProviderSetup.mockRejectedValueOnce(new Error("setup failed"));

    await expect(
      noteMemorySearchHealth(
        conversationRecallConfig({
          entries: { "active-memory": { enabled: false } },
        }),
      ),
    ).rejects.toThrow("setup failed");

    expect(note).toHaveBeenCalledOnce();
    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but the Active Memory plugin is disabled. Enable the plugin or set memory.search.rememberAcrossConversations to false.',
    );
  });

  it("uses the memory-core recovery message when the local provider plugin is missing", async () => {
    listProviderPolicyOwners.mockReturnValueOnce([]);
    await runMemorySearchHealth("local", {});

    expect(note).toHaveBeenCalledTimes(1);
    expectFirstNoteContains(
      "Unknown memory embedding provider: local",
      "openclaw plugins install @openclaw/llama-cpp-provider",
      "openclaw memory status --deep",
    );
    expect(getMissingLocalMemoryEmbeddingProviderMessage).toHaveBeenCalledOnce();
  });

  it("updates a legacy installed provider that has no setup policy artifact", async () => {
    loadProviderPolicyArtifacts.mockReturnValueOnce({
      owner: { id: "llama-cpp" },
      surface: null,
    });

    await runMemorySearchHealth(
      "local",
      failedGatewayOptions("legacy llama.cpp server is unavailable"),
    );

    expectFirstNoteContains(
      'Installed plugin "llama-cpp" does not provide current local-memory setup diagnostics',
      "legacy llama.cpp server is unavailable",
      "openclaw plugins update llama-cpp",
    );
    expectFirstNoteExcludes("openclaw plugins install @openclaw/llama-cpp-provider");
  });

  it.each([
    [
      "blocked-by-denylist",
      'Installed plugin "llama-cpp" is blocked by plugins.deny',
      'Remove "llama-cpp" from plugins.deny',
    ],
    [
      "plugin-disabled",
      'Installed plugin "llama-cpp" is disabled for this config',
      "openclaw plugins enable llama-cpp --accept-capabilities",
    ],
    [
      "not-in-allowlist",
      'Installed plugin "llama-cpp" is omitted from plugins.allow',
      'Include "llama-cpp" in plugins.allow',
    ],
  ] as const)("handles the %s installed-provider policy block", async (reason, message, fix) => {
    resolveManifestOwnerBasePolicyBlock.mockReturnValueOnce(reason);

    await runMemorySearchHealth("local", failedGatewayOptions("local provider is blocked"));

    expectFirstNoteContains(message, "local provider is blocked", fix);
    expectFirstNoteExcludes(
      "openclaw plugins install @openclaw/llama-cpp-provider",
      "openclaw plugins update llama-cpp",
    );
    expect(loadProviderPolicyArtifacts).not.toHaveBeenCalled();
  });

  it("reports global plugin disablement before the inactive memory-runtime gate", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValueOnce(null);

    await runMemorySearchHealth(
      "local",
      failedGatewayOptions("local provider is blocked"),
      undefined,
      { plugins: { enabled: false } },
    );

    expectFirstNoteContains(
      "Plugin loading is disabled for this config",
      "openclaw config set plugins.enabled true --strict-json",
    );
    expectFirstNoteExcludes("No active memory plugin is registered");
    expect(resolveActiveMemoryBackendConfig).not.toHaveBeenCalled();
    expect(loadProviderPolicyArtifacts).not.toHaveBeenCalled();
  });

  it("uses the policy owner selected after an earlier disabled owner", async () => {
    const earlierOwner = { id: "a-disabled" };
    const selectedOwner = { id: "b-policy" };
    listProviderPolicyOwners.mockReturnValueOnce([earlierOwner, selectedOwner]);
    loadProviderPolicyArtifacts.mockImplementationOnce((owners) => {
      const owner = owners[0];
      if (!owner) {
        throw new Error("missing selected provider owner");
      }
      return {
        owner,
        surface: { inspectEmbeddingProviderSetup: inspectConfiguredEmbeddingProviderSetup },
      };
    });
    resolveManifestOwnerBasePolicyBlock.mockImplementationOnce((params) =>
      params?.plugin.id === earlierOwner.id ? "plugin-disabled" : null,
    );
    inspectConfiguredEmbeddingProviderSetup.mockResolvedValueOnce({
      provider: "local",
      reason: "Selected provider needs setup.",
      requirement: "selected-provider-setup",
      fixHint: "Configure the selected provider.",
    });

    await runMemorySearchHealth("local", failedGatewayOptions("local provider is unavailable"));

    expect(resolveManifestOwnerBasePolicyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: selectedOwner }),
    );
    expect(loadProviderPolicyArtifacts).toHaveBeenCalledWith([selectedOwner]);
    expectFirstNoteContains("Selected provider needs setup", "Configure the selected provider");
    expectFirstNoteExcludes("openclaw plugins enable a-disabled");
  });

  it("still reports a missing memory backend in intentional FTS-only mode", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    await runMemorySearchHealth("none", {}, { fallback: "none" });

    expect(note).toHaveBeenCalledWith(
      "No active memory plugin is registered for the current config.",
      "Memory search",
    );
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("reports last-known llama.cpp runtime facts from the gateway", async () => {
    await runMemorySearchHealth("local", {
      gatewayMemoryProbe: {
        checked: true,
        ready: true,
        runtimeFacts: {
          engine: "llama.cpp",
          state: "ready",
          backend: "metal",
          buildInfo: "b10357 (689e227db)",
          model: { id: "embedding-model", path: "/models/embedding.gguf" },
          capabilities: { vision: false, draft: false },
          endpoints: {
            health: "ready",
            models: "ready",
            props: "ready",
            metrics: "ready",
          },
        },
      },
    });

    expect(note).toHaveBeenCalledWith(
      [
        "llama.cpp server: metal, b10357 (689e227db)",
        "Model: embedding-model (/models/embedding.gguf)",
        "Capabilities: text only",
        "Endpoints: health=ready models=ready props=ready metrics=ready",
      ].join("\n"),
      "Memory search",
    );
  });

  it("reports failed llama.cpp runtime facts alongside the readiness warning", async () => {
    await runMemorySearchHealth("local", {
      gatewayMemoryProbe: {
        checked: true,
        ready: false,
        error: "GGUF load failed",
        runtimeFacts: {
          engine: "llama.cpp",
          state: "failed",
          backend: "cpu",
          buildInfo: "b10357 (689e227db)",
          model: { id: "embedding-model" },
          capabilities: { vision: false, draft: false },
          endpoints: {
            health: "unavailable",
            models: "unavailable",
            props: "unavailable",
            metrics: "unavailable",
          },
          loadError: "GGUF load failed",
        },
      },
    });

    expect(note).toHaveBeenCalledTimes(1);
    expectFirstNoteContains(
      "llama.cpp server: cpu, b10357 (689e227db) (failed)",
      "Model: embedding-model",
      "Endpoints: health=unavailable models=unavailable props=unavailable metrics=unavailable",
      "Load error: GGUF load failed",
      "local embeddings are not confirmed ready",
      "Repair the llama.cpp server problem reported by the Gateway",
    );
    expectFirstNoteExcludes(
      "Gateway check: GGUF load failed",
      "openclaw plugins install @openclaw/llama-cpp-provider",
    );
  });

  it("does not warn when local provider readiness probe was intentionally skipped", async () => {
    await runMemorySearchHealth(
      "local",
      {
        gatewayMemoryProbe: {
          checked: false,
          ready: false,
          error:
            "memory embedding readiness not checked; run `openclaw memory status --deep` to check",
          skipped: true,
        },
      },
      { local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" } },
    );

    expect(note).not.toHaveBeenCalled();
  });

  it("warns when local provider skipped readiness but configured local model is missing", async () => {
    await runMemorySearchHealth(
      "local",
      {
        gatewayMemoryProbe: {
          checked: false,
          ready: false,
          error:
            "memory embedding readiness not checked; run `openclaw memory status --deep` to check",
          skipped: true,
        },
      },
      { local: { modelPath: "/definitely/missing/openclaw-memory-model.gguf" } },
    );

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain('Memory search provider is set to "local"');
  });

  it("warns when local provider has an explicit hf: modelPath but readiness was not confirmed", async () => {
    await runMemorySearchHealth(
      "local",
      {},
      {
        local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" },
      },
    );

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("a local model path is configured");
  });

  it.each([
    [
      "does not warn when an enabled alternate memory plugin owns the memory slot",
      {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": { enabled: true, config: { dbPath: ".openclaw/memory" } } },
      },
      true,
    ],
    [
      "still warns when an alternate memory slot entry is disabled",
      {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": { enabled: false } },
      },
      false,
    ],
    [
      "still warns when an alternate memory slot entry is only a placeholder",
      {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": {} },
      },
      false,
    ],
  ])("%s", async (_name, plugins, isActive) => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    const config = { session: { dmScope: "per-peer" }, plugins } as unknown as OpenClawConfig;
    await runMemorySearchHealth("auto", undefined, undefined, config);
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
    if (isActive) {
      expect(note).not.toHaveBeenCalled();
    } else {
      expect(note).toHaveBeenCalledTimes(1);
      expect(firstNoteMessage()).toContain("No active memory plugin is registered");
    }
  });

  it("does not warn when CLI backend resolution is missing but gateway memory is ready", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    await runMemorySearchHealth("auto", readyGatewayOptions);
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it.each([
    {
      memoryProvider: "custom-memory",
      activeMemoryConfig: { toolsAllow: ["memory_search"] },
    },
  ])(
    "warns when the $memoryProvider provider lacks protected transcript recall",
    async ({ memoryProvider, activeMemoryConfig }) => {
      await runConversationRecallHealth({
        slots: { memory: memoryProvider },
        entries: {
          "active-memory": {
            enabled: true,
            ...(activeMemoryConfig ? { config: activeMemoryConfig } : {}),
          },
        },
      });

      expect(firstNoteMessage()).toBe(
        'Remember across conversations is effectively enabled for agent "personal", but the current memory provider does not support protected private transcript recall. Set memory.search.rememberAcrossConversations to false or use that provider\'s own recall path; advanced Active Memory can still use its recall tools.',
      );
    },
  );

  it("warns when Active Memory excludes memory_search for conversation recall", async () => {
    await runConversationRecallHealth({
      entries: {
        "active-memory": { enabled: true, config: { toolsAllow: ["memory_get"] } },
      },
    });

    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but Active Memory does not allow memory_search. Add memory_search to the plugin toolsAllow list or set memory.search.rememberAcrossConversations to false.',
    );
  });

  it.each([
    { provider: "gemini", authProvider: "google", secretId: "GOOGLE_API_KEY", keyKind: "store" },
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
                  : secretId,
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

  it.each([["warns for explicit empty auth order when lint skips profile resolution", []]])(
    "%s",
    async (_name, profileIds) => {
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
    },
  );

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
});
