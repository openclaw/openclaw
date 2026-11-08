import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { DoctorMemoryEmbeddingRuntimePayload } from "../gateway/server-methods/doctor.js";
import type { ManifestOwnerBasePolicyBlockReason } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { MemoryHealth } from "../plugins/memory-provider-types.js";

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
const loadProviderPolicyArtifactsAsync = vi.hoisted(() =>
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
  vi.fn<(_params?: { plugin: { id: string } }) => ManifestOwnerBasePolicyBlockReason | null>(
    () => null,
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

// mock-isolation: Capture memory-health notices without rendering terminal UI.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  tryResolveDefaultAgentId: resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
}));

// mock-isolation: Memory search configuration is supplied by each health scenario.
vi.mock("../agents/memory-search.js", () => ({ resolveMemorySearchConfig }));

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

// mock-isolation: Provider acquisition and backend selection use fixture-owned runtime state.
vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemoryProviderCore,
  getActiveMemorySearchManagerCore: vi.fn(),
  resolveActiveMemoryBackendConfig,
}));

// mock-isolation: Health scenarios must not discover or activate the host's plugins.
vi.mock("../plugins/plugin-registry.js", () => ({ loadPluginManifestRegistryForPluginRegistry }));

// mock-isolation: Fixtures select the installed-provider policy outcome explicitly.
vi.mock("../plugins/manifest-owner-policy.js", () => ({ resolveManifestOwnerBasePolicyBlock }));

// mock-isolation: Memory health fixtures select policy hooks without executing installed plugins.
vi.mock("../plugins/provider-public-artifacts.js", () => ({
  listProviderPolicyOwners,
  loadProviderPolicyArtifactsAsync,
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

const firstNoteMessage = () => String(note.mock.calls[0]?.[0] ?? "");
function expectFirstNoteContains(...values: string[]) {
  expect(note).toHaveBeenCalledTimes(1);
  for (const value of values) {
    expect(firstNoteMessage()).toContain(value);
  }
}
function expectFirstNoteExcludes(...values: string[]) {
  for (const value of values) {
    expect(firstNoteMessage()).not.toContain(value);
  }
}

const cfg: OpenClawConfig = {};
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
const compatibleRemote = { baseUrl: "http://127.0.0.1:1234/v1" };
function providerConfig(provider: string, overrides: Partial<ModelProviderConfig>): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: { baseUrl: "https://embeddings.example.test/v1", models: [], ...overrides },
      },
    },
  };
}
function localRuntimeFacts(failed = false): DoctorMemoryEmbeddingRuntimePayload {
  const endpoint = failed ? "unavailable" : "ready";
  return {
    engine: "llama.cpp",
    state: failed ? "failed" : "ready",
    backend: failed ? "cpu" : "metal",
    buildInfo: "b10357 (689e227db)",
    model: { id: "embedding-model", ...(failed ? {} : { path: "/models/embedding.gguf" }) },
    capabilities: { vision: false, draft: false },
    endpoints: { health: endpoint, models: endpoint, props: endpoint, metrics: endpoint },
    ...(failed ? { loadError: "GGUF load failed" } : {}),
  };
}

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

const recallAgent = (rememberAcrossConversations: boolean) => ({
  memory: { search: { rememberAcrossConversations } },
});
function conversationRecallConfig(plugins?: OpenClawConfig["plugins"]): OpenClawConfig {
  return { agents: { entries: { personal: recallAgent(true) } }, plugins };
}

async function runConversationRecallHealth(plugins?: OpenClawConfig["plugins"]) {
  await runMemorySearchHealth("none", undefined, undefined, conversationRecallConfig(plugins));
}

async function runAuthLintHealth(provider: "openai" | "bedrock", config: OpenClawConfig = cfg) {
  await runMemorySearchHealth(provider, skippedAuthProfileOptions, undefined, config);
}

beforeEach(() => {
  note.mockClear();
  listAgentIds.mockImplementation((config: OpenClawConfig) =>
    config.agents?.entries ? Object.keys(config.agents.entries) : ["agent-default"],
  );
  resolveMemorySearchConfig.mockReset();
  resolveApiKeyForProviderCore.mockReset().mockRejectedValue(new Error("missing key"));
  hasAnyAuthProfileStoreSource.mockReset().mockReturnValue(true);
  hasAuthProfileStoreSourceForProvider.mockReset().mockReturnValue(true);
  isConfiguredAwsSdkAuthProfileForProvider.mockReset().mockReturnValue(false);
  getActiveMemoryProviderCore.mockReset();
  getMissingLocalMemoryEmbeddingProviderMessage.mockClear();
  inspectConfiguredEmbeddingProviderSetup.mockReset().mockResolvedValue(null);
  listProviderPolicyOwners.mockReset().mockReturnValue([{ id: "llama-cpp" }]);
  loadProviderPolicyArtifactsAsync.mockReset().mockImplementation((owners) => {
    const owner = owners[0];
    return owner
      ? {
          owner,
          surface: { inspectEmbeddingProviderSetup: inspectConfiguredEmbeddingProviderSetup },
        }
      : null;
  });
  resolveManifestOwnerBasePolicyBlock.mockReset().mockReturnValue(null);
  resolveActiveMemoryBackendConfig.mockReset().mockReturnValue({ backend: "builtin" });
});

function configureProviderHealth(health: MemoryHealth) {
  const close = vi.fn().mockResolvedValue(undefined);
  stubMemorySearchConfig("none");
  resolveActiveMemoryBackendConfig.mockReturnValue({
    backend: "provider-runtime",
    providerId: "records",
  });
  getActiveMemoryProviderCore.mockResolvedValue({
    providerId: "records",
    provider: {
      health: vi.fn().mockResolvedValue(health),
      close,
    },
  });
  return close;
}

function collectFindings(config: OpenClawConfig) {
  return collectMemorySearchHealthFindings({
    mode: "lint",
    cfg: config,
    env: { OPENCLAW_STATE_DIR: "/isolated-memory-state" },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
}

it("reports native provider health as an informational doctor note", async () => {
  const close = configureProviderHealth({ status: "ready", message: "connected" });

  await noteMemorySearchHealth(cfg, { includeWorkspaceMemoryHealth: false });

  expectFirstNoteContains(
    "Not applicable: records uses the provider runtime",
    "Provider health: ready (connected)",
  );
  expect(close).toHaveBeenCalledOnce();
});

it("collects a native provider acquisition failure as an unavailable warning", async () => {
  const close = configureProviderHealth({ status: "ready" });
  getActiveMemoryProviderCore.mockRejectedValue(new Error("connection failed"));

  const findings = await collectFindings(cfg);

  expect(findings).toMatchObject([
    {
      checkId: "core/doctor/memory-search",
      severity: "warning",
      path: "plugins.slots.memory",
    },
  ]);
  const diagnostic = `${findings[0]?.message} ${findings[0]?.fixHint}`;
  expect(diagnostic).toContain("records");
  expect(diagnostic).toContain("unavailable");
  expect(diagnostic).toContain("connection failed");
  expect(close).not.toHaveBeenCalled();
});

it("preserves disabled-memory lint filtering with multiple agents", async () => {
  const config: OpenClawConfig = {
    agents: { entries: { personal: recallAgent(false), secondary: recallAgent(false) } },
  };
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

  expectFirstNoteContains(
    "Unknown memory embedding provider: local",
    "openclaw plugins install @openclaw/llama-cpp-provider",
    "openclaw memory status --deep",
  );
  expect(getMissingLocalMemoryEmbeddingProviderMessage).toHaveBeenCalledOnce();
});

it("updates a legacy installed provider that has no setup policy artifact", async () => {
  loadProviderPolicyArtifactsAsync.mockReturnValueOnce({
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
  expect(loadProviderPolicyArtifactsAsync).not.toHaveBeenCalled();
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
  expect(loadProviderPolicyArtifactsAsync).not.toHaveBeenCalled();
});

it("uses the policy owner selected after an earlier disabled owner", async () => {
  const earlierOwner = { id: "a-disabled" };
  const selectedOwner = { id: "b-policy" };
  listProviderPolicyOwners.mockReturnValueOnce([earlierOwner, selectedOwner]);
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
  expect(loadProviderPolicyArtifactsAsync).toHaveBeenCalledWith([selectedOwner]);
  expectFirstNoteContains("Selected provider needs setup", "Configure the selected provider");
  expectFirstNoteExcludes("openclaw plugins enable a-disabled");
});

it.each([true, false])("reports llama.cpp runtime facts (ready=%s)", async (ready) => {
  await runMemorySearchHealth("local", {
    gatewayMemoryProbe: {
      checked: true,
      ready,
      ...(ready ? {} : { error: "GGUF load failed" }),
      runtimeFacts: localRuntimeFacts(!ready),
    },
  });
  if (ready) {
    expect(note).toHaveBeenCalledWith(
      [
        "llama.cpp server: metal, b10357 (689e227db)",
        "Model: embedding-model (/models/embedding.gguf)",
        "Capabilities: text only",
        "Endpoints: health=ready models=ready props=ready metrics=ready",
      ].join("\n"),
      "Memory search",
    );
  } else {
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
  }
});

it.each([
  ["skipped downloadable model", "hf:some-org/some-model-GGUF/model.gguf", true, null],
  [
    "skipped missing local model",
    "/definitely/missing/openclaw-memory-model.gguf",
    true,
    'Memory search provider is set to "local"',
  ],
  [
    "unconfirmed downloadable model",
    "hf:some-org/some-model-GGUF/model.gguf",
    false,
    "a local model path is configured",
  ],
] as const)("handles %s readiness", async (_name, modelPath, skipped, warning) => {
  const options = skipped
    ? {
        gatewayMemoryProbe: {
          checked: false,
          ready: false,
          skipped: true,
          error:
            "memory embedding readiness not checked; run `openclaw memory status --deep` to check",
        },
      }
    : {};
  await runMemorySearchHealth("local", options, { local: { modelPath } });
  if (warning === null) {
    expect(note).not.toHaveBeenCalled();
  } else {
    expectFirstNoteContains(warning);
  }
});

it.each([
  ["enabled", { enabled: true, config: { dbPath: ".openclaw/memory" } }, true],
  ["disabled", { enabled: false }, false],
  ["placeholder", {}, false],
  ["default slot", undefined, false],
] as const)("checks an %s alternate memory slot entry", async (_name, entry, isActive) => {
  resolveActiveMemoryBackendConfig.mockReturnValue(null);
  const config: OpenClawConfig = entry
    ? {
        session: { dmScope: "per-peer" },
        plugins: { slots: { memory: "memory-lancedb" }, entries: { "memory-lancedb": entry } },
      }
    : cfg;
  await runMemorySearchHealth("none", undefined, { fallback: "none" }, config);
  expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  if (isActive) {
    expect(note).not.toHaveBeenCalled();
  } else {
    expect(note).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledWith(
      "No active memory plugin is registered for the current config.",
      "Memory search",
    );
  }
});

it("does not warn when CLI backend resolution is missing but gateway memory is ready", async () => {
  resolveActiveMemoryBackendConfig.mockReturnValue(null);
  await runMemorySearchHealth("auto", readyGatewayOptions);
  expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  expect(note).not.toHaveBeenCalled();
});

it.each([
  [
    "custom provider",
    {
      slots: { memory: "custom-memory" },
      entries: { "active-memory": { enabled: true, config: { toolsAllow: ["memory_search"] } } },
    },
    'Remember across conversations is effectively enabled for agent "personal", but the current memory provider does not support protected private transcript recall. Set memory.search.rememberAcrossConversations to false or use that provider\'s own recall path; advanced Active Memory can still use its recall tools.',
  ],
  [
    "excluded memory_search",
    {
      entries: { "active-memory": { enabled: true, config: { toolsAllow: ["memory_get"] } } },
    },
    'Remember across conversations is effectively enabled for agent "personal", but Active Memory does not allow memory_search. Add memory_search to the plugin toolsAllow list or set memory.search.rememberAcrossConversations to false.',
  ],
] satisfies Array<[string, OpenClawConfig["plugins"], string]>)(
  "warns about protected conversation recall with %s",
  async (_name, plugins, message) => {
    await runConversationRecallHealth(plugins);
    expect(firstNoteMessage()).toBe(message);
  },
);

it.each([
  { provider: "gemini", authProvider: "google", secretId: "GOOGLE_API_KEY", keyKind: "store" },
  { provider: "openai", authProvider: "openai", secretId: "OPENAI_API_KEY", keyKind: "marker" },
] as const)(
  "checks a $keyKind key for $provider",
  async ({ provider, authProvider, secretId, keyKind }) => {
    hasAnyAuthProfileStoreSource.mockReturnValue(false);
    const config = providerConfig(authProvider, {
      apiKey:
        keyKind === "store" ? { source: "store", provider: "default", id: secretId } : secretId,
    });
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

it("resolves provider auth from the default agent directory", async () => {
  resolveApiKeyForProviderCore.mockResolvedValue(undefined);
  await runMemorySearchHealth("gemini");
  expect(resolveApiKeyForProviderCore).toHaveBeenCalledWith({
    provider: "google",
    cfg,
    agentDir: "/tmp/agent-default",
  });
  expect(note).not.toHaveBeenCalled();
});

it("does not warn for ollama when gateway probe is ready without CLI API key", async () => {
  await runMemorySearchHealth("ollama", readyGatewayOptions);
  expect(note).not.toHaveBeenCalled();
  expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
});

it("warns when lmstudio gateway probe reports embeddings are not ready", async () => {
  await runMemorySearchHealth("lmstudio", failedGatewayOptions("LM API token missing"));
  expectFirstNoteContains('provider "lmstudio" is configured', "embeddings are not ready");
});

it.each([
  ["baseUrl", {}, "remote.baseUrl"],
  ["model", { model: "   ", remote: compatibleRemote }, "memory.search.model"],
])(
  "requires an OpenAI-compatible %s even when probing is skipped",
  async (_name, overrides, path) => {
    await runMemorySearchHealth("openai-compatible", skippedGatewayOptions, overrides);
    expectFirstNoteContains('provider is set to "openai-compatible"', path, "openclaw config set");
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  },
);

it("does not warn for baseUrl-only OpenAI-compatible custom providers when probe was skipped", async () => {
  await runMemorySearchHealth(
    "localEmbeddings",
    skippedGatewayOptions,
    { model: "text-embedding-bge-m3" },
    providerConfig("localEmbeddings", compatibleRemote),
  );
  expect(note).not.toHaveBeenCalled();
  expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
});

it.each([false, true])("warns for empty auth sources (explicit order=%s)", async (ordered) => {
  hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
  await runAuthLintHealth("openai", ordered ? { auth: { order: { openai: [] } } } : cfg);
  if (ordered) {
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
      { profileIds: [] },
    );
  } else {
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
    );
    expectFirstNoteContains("OPENAI_API_KEY");
  }
  expectFirstNoteContains('provider is set to "openai"');
  expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
});

it("does not warn for Bedrock aws-sdk provider auth when lint skips profile resolution", async () => {
  await runAuthLintHealth("bedrock", providerConfig("amazon-bedrock", { auth: "aws-sdk" }));

  expect(note).not.toHaveBeenCalled();
  expect(hasAuthProfileStoreSourceForProvider).not.toHaveBeenCalled();
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
