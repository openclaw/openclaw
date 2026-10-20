import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { listProviderPolicyOwners as collectPolicyOwners } from "../plugins/provider-policy-owners.js";

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
  const sessionMemory = {
    sources: ["memory", "sessions"],
    experimental: { sessionMemory: true },
  };
  const conversationRecall = {
    ...sessionMemory,
    rememberAcrossConversations: true,
  };
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

  function conversationRecallConfig(
    plugins?: OpenClawConfig["plugins"],
    rememberAcrossConversations = true,
  ): OpenClawConfig {
    return {
      agents: {
        entries: {
          personal: {
            memory: { search: { rememberAcrossConversations } },
          },
        },
      },
      ...(plugins ? { plugins } : {}),
    } as OpenClawConfig;
  }

  async function runConversationRecallHealth(
    plugins?: OpenClawConfig["plugins"],
    rememberAcrossConversations = true,
    overrides: Record<string, unknown> = conversationRecall,
  ) {
    await runMemorySearchHealth(
      "none",
      undefined,
      overrides,
      conversationRecallConfig(plugins, rememberAcrossConversations),
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

  it("reports an unavailable backend at the memory plugin slot", async () => {
    stubMemorySearchConfig("none");
    resolveActiveMemoryBackendConfig.mockReturnValue(null);

    expect(await collectFindings()).toEqual([
      {
        checkId: "core/doctor/memory-search",
        severity: "warning",
        path: "plugins.slots.memory",
        message: "No active memory plugin is registered for the current config.",
      },
    ]);
  });

  registerProviderRuntimeDoctorTest({
    cfg,
    stubMemorySearchConfig,
    noteMemorySearchHealth,
    expectFirstNoteContains,
  });

  it.each([false, true])(
    "preserves disabled-memory lint filtering with multiple agents=%s",
    async (multiple) => {
      const config = {
        agents: {
          entries: Object.fromEntries(
            (multiple ? ["personal", "secondary"] : ["personal"]).map((id) => [
              id,
              { memory: { search: { rememberAcrossConversations: false } } },
            ]),
          ),
        },
      } as OpenClawConfig;
      resolveMemorySearchConfig.mockReturnValue(undefined);

      const findings = await collectFindings(config);

      expect(findings.map(({ message, path }) => ({ message, path }))).toEqual(
        multiple
          ? [
              {
                message: 'Agent "personal": Memory search is explicitly disabled (enabled: false).',
                path: "memory.search.provider",
              },
              {
                message:
                  'Agent "secondary": Memory search is explicitly disabled (enabled: false).',
                path: "memory.search.provider",
              },
            ]
          : [],
      );
    },
  );

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

  it.each([
    failedGatewayOptions("Managed local embeddings are unavailable."),
    skippedGatewayOptions,
  ])("uses bundled provider setup guidance for Gateway probe %j", async (options) => {
    const owner = createPluginManifestRecordFixture({
      id: "llama-cpp",
      contracts: { embeddingProviders: ["local"] },
    });
    loadPluginManifestRegistryForPluginRegistry.mockReturnValueOnce({
      plugins: [owner],
      diagnostics: [],
    });
    listProviderPolicyOwners.mockImplementationOnce(collectPolicyOwners);
    inspectConfiguredEmbeddingProviderSetup.mockResolvedValueOnce({
      provider: "local",
      reason: "Local embeddings need the managed llama.cpp server config.",
      requirement: "managed-llama-cpp-setup",
      fixHint:
        "Run `openclaw models --agent agent-default auth login --provider llama-cpp --method local` in an interactive terminal, then rerun this check.",
    });

    await runMemorySearchHealth("local", options);

    expect(loadProviderPolicyArtifacts).toHaveBeenCalledWith([owner]);
    expectFirstNoteContains(
      "Local embeddings need the managed llama.cpp server config",
      "openclaw models --agent agent-default auth login --provider llama-cpp --method local",
    );
    expectFirstNoteExcludes("openclaw plugins install @openclaw/llama-cpp-provider");
  });

  it("collects local setup findings without printing notes or inspecting workspace memory", async () => {
    stubMemorySearchConfig("local");
    inspectConfiguredEmbeddingProviderSetup.mockResolvedValueOnce({
      reason: "Local embeddings need the managed llama.cpp server config",
      fixHint: "Configure the local provider",
    });

    expect(await collectFindings()).toEqual([
      expect.objectContaining({
        path: "memory.search.provider",
        message:
          'Memory search provider is set to "local", but local embeddings are not confirmed ready.',
        fixHint: expect.stringContaining("Configure the local provider"),
      }),
    ]);
    expect(noteWorkspaceMemoryHealth).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(inspectConfiguredEmbeddingProviderSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { OPENCLAW_STATE_DIR: "/isolated-memory-state" },
      }),
    );
  });

  it("warns when local provider with default model but gateway probe reports not ready", async () => {
    await runMemorySearchHealth("local", failedGatewayOptions("managed llama-server unavailable"));

    expect(note).toHaveBeenCalledTimes(1);
    expectFirstNoteContains(
      "local embeddings are not confirmed ready",
      "managed llama-server unavailable",
      "Repair the llama.cpp server problem reported by the Gateway",
    );
    expectFirstNoteExcludes("openclaw plugins install @openclaw/llama-cpp-provider");
  });

  it("does not warn when local provider with default model and gateway probe is ready", async () => {
    await runMemorySearchHealth("local", readyGatewayOptions);

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn or request NONE_API_KEY for intentional FTS-only mode", async () => {
    await runMemorySearchHealth("none", {}, { fallback: "none" });

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
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
      "still warns when an alternate memory slot has no configured plugin entry",
      { slots: { memory: "memory-lancedb" } },
      false,
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

  it("does not warn about conversation recall when the setting is off", async () => {
    await runConversationRecallHealth(undefined, false, {});

    expect(note).not.toHaveBeenCalled();
  });

  it("does not treat Lossless Claw's context-engine slot as a memory-slot conflict", async () => {
    await runConversationRecallHealth({
      slots: { contextEngine: "lossless-claw" },
      entries: {
        "active-memory": { enabled: true },
        "lossless-claw": { enabled: true },
      },
    });

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

  it("warns when conversation recall is enabled but Active Memory is disabled", async () => {
    await runConversationRecallHealth({
      entries: { "active-memory": { enabled: false } },
    });

    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but the Active Memory plugin is disabled. Enable the plugin or set memory.search.rememberAcrossConversations to false.',
    );
  });

  it("warns when conversation recall is enabled but Active Memory is paused in plugin config", async () => {
    await runConversationRecallHealth({
      entries: {
        "active-memory": { enabled: true, config: { enabled: false } },
      },
    });

    expect(firstNoteMessage()).toContain("Active Memory plugin is disabled");
  });

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

  it("warns when an opted-in agent has memory search disabled", async () => {
    const memoryCfg = {
      agents: {
        entries: { personal: { memory: { search: { rememberAcrossConversations: true } } } },
      },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "personal"
        ? undefined
        : { provider: "openai", local: {}, remote: {}, sources: ["memory"] },
    );

    await noteMemorySearchHealth(memoryCfg);

    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but memory search is disabled. Enable memory search or set memory.search.rememberAcrossConversations to false.',
    );
  });
});
