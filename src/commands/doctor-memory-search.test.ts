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

  it("does not warn in auto mode when remote apiKey is configured", async () => {
    await expectNoWarningWithConfiguredRemoteApiKey("auto");
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

  it("uses model configure hint in auto mode when no provider credentials are found", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("openclaw configure --section model");
    expect(message).not.toContain("openclaw auth add --provider");
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
