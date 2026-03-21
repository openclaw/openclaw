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

import { noteMemorySearchHealth } from "./doctor-memory-search.js";
import { detectLegacyWorkspaceDirs } from "./doctor-workspace.js";

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
    expect(message).toContain("needs at least one embedding provider");
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
