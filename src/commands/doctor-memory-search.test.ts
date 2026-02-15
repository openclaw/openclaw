import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "agent-default"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent-default"));
const resolveMemorySearchConfig = vi.hoisted(() => vi.fn());
const resolveApiKeyForProvider = vi.hoisted(() => vi.fn());
const resolveMemoryBackendConfig = vi.hoisted(() =>
  vi.fn(() => ({ backend: "builtin", citations: "auto" })),
);

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

describe("noteMemorySearchHealth", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    note.mockReset();
    resolveDefaultAgentId.mockClear();
    resolveAgentDir.mockClear();
    resolveMemorySearchConfig.mockReset();
    resolveApiKeyForProvider.mockReset();
    resolveMemoryBackendConfig.mockReset();
    resolveMemoryBackendConfig.mockReturnValue({ backend: "builtin", citations: "auto" });
  });

  it("does not warn when remote apiKey is configured for explicit provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      local: {},
      remote: { apiKey: "from-config" },
    });

    await noteMemorySearchHealth(cfg);

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn in auto mode when remote apiKey is configured", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: { apiKey: "from-config" },
    });

    await noteMemorySearchHealth(cfg);

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn when memory backend is qmd (#17263)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });
    resolveMemoryBackendConfig.mockReturnValue({
      backend: "qmd",
      citations: "auto",
      qmd: {},
    });

    await noteMemorySearchHealth(cfg);

    // QMD handles embeddings internally — no warning expected.
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

    await noteMemorySearchHealth(cfg);

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "google",
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expect(note).not.toHaveBeenCalled();
  });
});
