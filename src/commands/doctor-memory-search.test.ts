import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "agent-default"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent-default"));
const resolveMemorySearchConfig = vi.hoisted(() => vi.fn());
const resolveApiKeyForProvider = vi.hoisted(() => vi.fn());
const resolveMemoryBackendConfig = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentDir,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider,
}));

vi.mock("../memory/backend-config.js", () => ({
  resolveMemoryBackendConfig,
}));

import { checkMemorySearch, noteMemorySearchDiagnostics } from "./doctor-memory-search.js";
import { noteMemorySearchHealth } from "./doctor-memory-search.js";
import { detectLegacyWorkspaceDirs } from "./doctor-workspace.js";

/**
 * Helper to create minimal memorySearch config for testing.
 */
function createMockMemorySearchConfig(overrides: {
  provider?: string;
  model?: string;
  remote?: Record<string, unknown>;
}) {
  return {
    provider: overrides.provider ?? "openai",
    model: overrides.model ?? "",
    local: {},
    remote: overrides.remote ?? {},
    enabled: true,
    sources: ["memory"],
    extraPaths: [],
    multimodal: { enabled: false },
    experimental: { sessionMemory: false },
    fallback: "none",
    store: { driver: "sqlite", path: "", vector: { enabled: true } },
    chunking: { tokens: 400, overlap: 80 },
    sync: {
      onSessionStart: true,
      onSearch: true,
      watch: true,
      watchDebounceMs: 1500,
      intervalMinutes: 0,
      sessions: { deltaBytes: 100000, deltaMessages: 50 },
    },
    query: {
      maxResults: 6,
      minScore: 0.35,
      hybrid: {
        enabled: true,
        vectorWeight: 0.7,
        textWeight: 0.3,
        candidateMultiplier: 4,
        mmr: { enabled: false, lambda: 0.7 },
        temporalDecay: { enabled: false, halfLifeDays: 30 },
      },
    },
    cache: { enabled: true },
  };
}

describe("noteMemorySearchHealth", () => {
  const cfg = {} as OpenClawConfig;

  async function expectNoWarningWithConfiguredRemoteApiKey(provider: string) {
    resolveMemorySearchConfig.mockReturnValue({
      provider,
      local: {},
      remote: { apiKey: "from-config" },
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    note.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveAgentDir.mockClear();
    resolveMemorySearchConfig.mockReset();
    resolveApiKeyForProvider.mockReset();
    resolveApiKeyForProvider.mockRejectedValue(new Error("missing key"));
    resolveMemoryBackendConfig.mockReset();
    resolveMemoryBackendConfig.mockReturnValue({ backend: "builtin", citations: "auto" });
  });

  it("does not warn when local provider is set with no explicit modelPath (default model fallback)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
  });

  it("warns when local provider with default model but gateway probe reports not ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: false, error: "node-llama-cpp not installed" },
    });

    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("gateway reports local embeddings are not ready");
    expect(message).toContain("node-llama-cpp not installed");
  });

  it("does not warn when local provider with default model and gateway probe is ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when local provider has an explicit hf: modelPath", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" },
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when QMD backend is active", async () => {
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "qmd",
      citations: "auto",
    });
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when remote apiKey is configured for explicit provider", async () => {
    await expectNoWarningWithConfiguredRemoteApiKey("openai");
  });

  it("treats SecretRef remote apiKey as configured for explicit provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      local: {},
      remote: {
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn in auto mode when remote apiKey is configured", async () => {
    await expectNoWarningWithConfiguredRemoteApiKey("auto");
  });

  it("treats SecretRef remote apiKey as configured in auto mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("resolves provider auth from the default agent directory", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "k",
      source: "env: GEMINI_API_KEY",
      mode: "api-key",
    });

    await noteMemorySearchHealth(cfg, {});

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "google",
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("resolves mistral auth for explicit mistral embedding provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "mistral",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "k",
      source: "env: MISTRAL_API_KEY",
      mode: "api-key",
    });

    await noteMemorySearchHealth(cfg);

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "mistral",
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("notes when gateway probe reports embeddings ready and CLI API key is missing", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    const message = note.mock.calls[0]?.[0] as string;
    expect(message).toContain("reports memory embeddings are ready");
  });

  it("uses model configure hint when gateway probe is unavailable and API key is missing", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: true,
        ready: false,
        error: "gateway memory probe unavailable: timeout",
      },
    });

    const message = note.mock.calls[0]?.[0] as string;
    expect(message).toContain("Gateway memory probe for default agent is not ready");
    expect(message).toContain("openclaw configure --section model");
    expect(message).not.toContain("openclaw auth add --provider");
  });

  it("warns in auto mode when no local modelPath and no API keys are configured", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    // In auto mode, canAutoSelectLocal requires an explicit local file path.
    // DEFAULT_LOCAL_MODEL fallback does NOT apply to auto — only to explicit
    // provider: "local". So with no local file and no API keys, warn.
    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("openclaw configure --section model");
  });

  it("still warns in auto mode when only ollama credentials exist", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockImplementation(async ({ provider }: { provider: string }) => {
      if (provider === "ollama") {
        return {
          apiKey: "ollama-local", // pragma: allowlist secret
          source: "env: OLLAMA_API_KEY",
          mode: "api-key",
        };
      }
      throw new Error("missing key");
    });

    await noteMemorySearchHealth(cfg);

    expect(note).toHaveBeenCalledTimes(1);
    const providerCalls = resolveApiKeyForProvider.mock.calls as Array<[{ provider: string }]>;
    const providersChecked = providerCalls.map(([arg]) => arg.provider);
    expect(providersChecked).toEqual(["openai", "google", "voyage", "mistral"]);
  });
});

describe("detectLegacyWorkspaceDirs", () => {
  it("returns active workspace and no legacy dirs", () => {
    const workspaceDir = "/home/user/openclaw";
    const detection = detectLegacyWorkspaceDirs({ workspaceDir });
    expect(detection.activeWorkspace).toBe(path.resolve(workspaceDir));
    expect(detection.legacyDirs).toEqual([]);
  });
});

describe("checkMemorySearch", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    resolveMemorySearchConfig.mockReset();
  });

  it("returns valid: true when memory search is disabled", async () => {
    resolveMemorySearchConfig.mockReturnValue(null);

    const result = await checkMemorySearch(cfg);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("returns valid when provider is 'auto' (valid runtime mode)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      model: "",
      local: {},
      remote: {},
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      multimodal: { enabled: false },
      experimental: { sessionMemory: false },
      fallback: "none",
      store: { driver: "sqlite", path: "", vector: { enabled: true } },
      chunking: { tokens: 400, overlap: 80 },
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        watchDebounceMs: 1500,
        intervalMinutes: 0,
        sessions: { deltaBytes: 100000, deltaMessages: 50 },
      },
      query: {
        maxResults: 6,
        minScore: 0.35,
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        },
      },
      cache: { enabled: true },
    });

    const result = await checkMemorySearch(cfg);

    // "auto" is a valid runtime mode
    expect(result.valid).toBe(true);
    expect(result.provider).toBe("auto");
    expect(result.issues).toHaveLength(0);
  });

  it("returns invalid when openai provider is missing apiKey", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "text-embedding-3-small",
      local: {},
      remote: {},
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      multimodal: { enabled: false },
      experimental: { sessionMemory: false },
      fallback: "none",
      store: { driver: "sqlite", path: "", vector: { enabled: true } },
      chunking: { tokens: 400, overlap: 80 },
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        watchDebounceMs: 1500,
        intervalMinutes: 0,
        sessions: { deltaBytes: 100000, deltaMessages: 50 },
      },
      query: {
        maxResults: 6,
        minScore: 0.35,
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        },
      },
      cache: { enabled: true },
    });

    const result = await checkMemorySearch(cfg);

    expect(result.valid).toBe(false);
    expect(result.provider).toBe("openai");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].field).toBe("remote.apiKey");
    expect(result.issues[0].fix).toContain("OPENAI_API_KEY");
  });

  it("returns valid when openai provider has no model (uses default)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "",
      local: {},
      remote: { apiKey: "test-key" },
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      multimodal: { enabled: false },
      experimental: { sessionMemory: false },
      fallback: "none",
      store: { driver: "sqlite", path: "", vector: { enabled: true } },
      chunking: { tokens: 400, overlap: 80 },
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        watchDebounceMs: 1500,
        intervalMinutes: 0,
        sessions: { deltaBytes: 100000, deltaMessages: 50 },
      },
      query: {
        maxResults: 6,
        minScore: 0.35,
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        },
      },
      cache: { enabled: true },
    });

    const result = await checkMemorySearch(cfg);

    // Model is optional - runtime has defaults
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("returns valid when openai has both apiKey and model", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "text-embedding-3-small",
      local: {},
      remote: { apiKey: "test-key" },
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      multimodal: { enabled: false },
      experimental: { sessionMemory: false },
      fallback: "none",
      store: { driver: "sqlite", path: "", vector: { enabled: true } },
      chunking: { tokens: 400, overlap: 80 },
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        watchDebounceMs: 1500,
        intervalMinutes: 0,
        sessions: { deltaBytes: 100000, deltaMessages: 50 },
      },
      query: {
        maxResults: 6,
        minScore: 0.35,
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        },
      },
      cache: { enabled: true },
    });

    const result = await checkMemorySearch(cfg);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("returns valid when ollama provider has no baseUrl (uses default)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "ollama",
      model: "nomic-embed-text",
      local: {},
      remote: {},
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      multimodal: { enabled: false },
      experimental: { sessionMemory: false },
      fallback: "none",
      store: { driver: "sqlite", path: "", vector: { enabled: true } },
      chunking: { tokens: 400, overlap: 80 },
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        watchDebounceMs: 1500,
        intervalMinutes: 0,
        sessions: { deltaBytes: 100000, deltaMessages: 50 },
      },
      query: {
        maxResults: 6,
        minScore: 0.35,
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        },
      },
      cache: { enabled: true },
    });

    const result = await checkMemorySearch(cfg);

    // baseUrl is optional - runtime uses default
    expect(result.valid).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.issues).toHaveLength(0);
  });

  it("returns valid when ollama provider has no model (uses default)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "ollama",
      model: "",
      local: {},
      remote: { baseUrl: "http://localhost:11434" },
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      multimodal: { enabled: false },
      experimental: { sessionMemory: false },
      fallback: "none",
      store: { driver: "sqlite", path: "", vector: { enabled: true } },
      chunking: { tokens: 400, overlap: 80 },
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        watchDebounceMs: 1500,
        intervalMinutes: 0,
        sessions: { deltaBytes: 100000, deltaMessages: 50 },
      },
      query: {
        maxResults: 6,
        minScore: 0.35,
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        },
      },
      cache: { enabled: true },
    });

    const result = await checkMemorySearch(cfg);

    // Model is optional - runtime has defaults
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("returns valid when ollama has both host and model", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "ollama",
      model: "nomic-embed-text",
      local: {},
      remote: { baseUrl: "http://localhost:11434" },
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      multimodal: { enabled: false },
      experimental: { sessionMemory: false },
      fallback: "none",
      store: { driver: "sqlite", path: "", vector: { enabled: true } },
      chunking: { tokens: 400, overlap: 80 },
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        watchDebounceMs: 1500,
        intervalMinutes: 0,
        sessions: { deltaBytes: 100000, deltaMessages: 50 },
      },
      query: {
        maxResults: 6,
        minScore: 0.35,
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        },
      },
      cache: { enabled: true },
    });

    const result = await checkMemorySearch(cfg);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("returns valid when openai has SecretRef apiKey configured", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "text-embedding-3-small",
      local: {},
      remote: {
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      multimodal: { enabled: false },
      experimental: { sessionMemory: false },
      fallback: "none",
      store: { driver: "sqlite", path: "", vector: { enabled: true } },
      chunking: { tokens: 400, overlap: 80 },
      sync: {
        onSessionStart: true,
        onSearch: true,
        watch: true,
        watchDebounceMs: 1500,
        intervalMinutes: 0,
        sessions: { deltaBytes: 100000, deltaMessages: 50 },
      },
      query: {
        maxResults: 6,
        minScore: 0.35,
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          mmr: { enabled: false, lambda: 0.7 },
          temporalDecay: { enabled: false, halfLifeDays: 30 },
        },
      },
      cache: { enabled: true },
    });

    const result = await checkMemorySearch(cfg);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

describe("noteMemorySearchDiagnostics", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    note.mockClear();
    resolveMemorySearchConfig.mockReset();
    resolveApiKeyForProvider.mockReset();
    resolveApiKeyForProvider.mockResolvedValue(null); // Default: no API key in env
  });

  it("does not output anything when memory search is disabled", async () => {
    resolveMemorySearchConfig.mockReturnValue(null);

    await noteMemorySearchDiagnostics(cfg);

    expect(note).not.toHaveBeenCalled();
  });

  it("does not output anything when configuration is valid", async () => {
    resolveMemorySearchConfig.mockReturnValue(
      createMockMemorySearchConfig({
        provider: "openai",
        model: "text-embedding-3-small",
        remote: { apiKey: "test-key" },
      }),
    );

    await noteMemorySearchDiagnostics(cfg);

    expect(note).not.toHaveBeenCalled();
  });

  it("does not output error when provider is 'auto' (valid runtime mode)", async () => {
    resolveMemorySearchConfig.mockReturnValue(
      createMockMemorySearchConfig({ provider: "auto", model: "" }),
    );

    await noteMemorySearchDiagnostics(cfg);

    // "auto" is a valid runtime mode - should not produce error
    expect(note).not.toHaveBeenCalled();
  });

  it("outputs structured error when openai provider has no apiKey and no env var", async () => {
    resolveMemorySearchConfig.mockReturnValue(
      createMockMemorySearchConfig({
        provider: "openai",
        model: "text-embedding-3-small",
        remote: {},
      }),
    );
    resolveApiKeyForProvider.mockResolvedValue(null); // No env var

    await noteMemorySearchDiagnostics(cfg);

    expect(note).toHaveBeenCalledTimes(1);
    const message = note.mock.calls[0]?.[0] as string;
    expect(message).toContain("[FAIL] memorySearch configuration invalid");
    expect(message).toContain("Provider: openai");
    expect(message).toContain("remote.apiKey");
    expect(message).toContain("apiKey");
    expect(message).toContain("OPENAI_API_KEY");
  });

  it("does not output error when openai provider has apiKey but no model (uses default)", async () => {
    resolveMemorySearchConfig.mockReturnValue(
      createMockMemorySearchConfig({
        provider: "openai",
        model: "",
        remote: { apiKey: "test-key" },
      }),
    );

    await noteMemorySearchDiagnostics(cfg);

    // Model is optional - runtime has defaults, so no error
    expect(note).not.toHaveBeenCalled();
  });

  it("does not output error when ollama provider has no baseUrl (uses default)", async () => {
    resolveMemorySearchConfig.mockReturnValue(
      createMockMemorySearchConfig({ provider: "ollama", model: "nomic-embed-text", remote: {} }),
    );

    await noteMemorySearchDiagnostics(cfg);

    // baseUrl is optional - runtime uses default, so no error
    expect(note).not.toHaveBeenCalled();
  });

  it("does not output error when openai has apiKey but no model (uses default)", async () => {
    resolveMemorySearchConfig.mockReturnValue(
      createMockMemorySearchConfig({
        provider: "openai",
        model: "",
        remote: { apiKey: "test-key" },
      }),
    );

    await noteMemorySearchDiagnostics(cfg);

    // Model is optional - no error when apiKey is present
    expect(note).not.toHaveBeenCalled();
  });

  it("does not output error for valid 'auto' provider mode", async () => {
    resolveMemorySearchConfig.mockReturnValue(
      createMockMemorySearchConfig({ provider: "auto", model: "", remote: {} }),
    );

    await noteMemorySearchDiagnostics(cfg);

    // "auto" is valid, no error
    expect(note).not.toHaveBeenCalled();
  });
});
