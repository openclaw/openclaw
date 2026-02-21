import { describe, expect, it, vi } from "vitest";
import type { AuthProbeResult } from "./list.probe.js";

// Mock heavy dependencies so we can test probe target selection without side effects.
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
  listProfilesForProvider: () => [],
  resolveAuthProfileDisplayLabel: () => "",
  resolveAuthProfileOrder: () => [],
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: () =>
    Promise.resolve([
      { provider: "test-helper", id: "test-model" },
      { provider: "test-env", id: "env-model" },
      { provider: "test-inline", id: "inline-model" },
      { provider: "test-none", id: "none-model" },
    ]),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/test-agent",
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "test",
  resolveAgentWorkspaceDir: () => "/tmp/test-workspace",
}));

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/tmp/test-workspace",
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionTranscriptPath: () => "/tmp/test-session.json",
  resolveSessionTranscriptsDirForAgent: () => "/tmp/test-sessions",
}));

vi.mock("node:fs/promises", () => ({
  default: { mkdir: vi.fn().mockResolvedValue(undefined) },
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Must import after mocks are set up.
const { runAuthProbes } = await import("./list.probe.js");

const baseOpts = {
  timeoutMs: 5000,
  concurrency: 1,
  maxTokens: 10,
};

describe("probe target selection with apiKeyHelper", () => {
  it("includes apiKeyHelper provider as a probe target", async () => {
    const cfg = {
      models: {
        providers: {
          "test-helper": {
            baseUrl: "http://localhost",
            apiKeyHelper: "echo 'key'",
            models: [{ id: "test-model", name: "Test" }],
          },
        },
      },
    };

    const summary = await runAuthProbes({
      cfg: cfg as unknown as Parameters<typeof runAuthProbes>[0]["cfg"],
      providers: ["test-helper"],
      modelCandidates: ["test-helper/test-model"],
      options: baseOpts,
    });

    const result = summary.results.find((r: AuthProbeResult) => r.provider === "test-helper");
    expect(result).toBeDefined();
    expect(result!.source).toBe("apiKeyHelper");
  });

  it("prefers env over apiKeyHelper for source label", async () => {
    const originalEnv = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-env-key";

    try {
      const cfg = {
        models: {
          providers: {
            openai: {
              baseUrl: "http://localhost",
              apiKeyHelper: "echo 'helper-key'",
              models: [{ id: "gpt-5.1", name: "GPT" }],
            },
          },
        },
      };

      const summary = await runAuthProbes({
        cfg: cfg as unknown as Parameters<typeof runAuthProbes>[0]["cfg"],
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.1"],
        options: baseOpts,
      });

      const result = summary.results.find((r: AuthProbeResult) => r.provider === "openai");
      expect(result).toBeDefined();
      expect(result!.source).toBe("env");
    } finally {
      if (originalEnv !== undefined) {
        process.env.OPENAI_API_KEY = originalEnv;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  it("skips provider with no auth configured", async () => {
    const cfg = {
      models: {
        providers: {
          "test-none": {
            baseUrl: "http://localhost",
            models: [{ id: "none-model", name: "No Auth" }],
          },
        },
      },
    };

    const summary = await runAuthProbes({
      cfg: cfg as unknown as Parameters<typeof runAuthProbes>[0]["cfg"],
      providers: ["test-none"],
      modelCandidates: ["test-none/none-model"],
      options: baseOpts,
    });

    const result = summary.results.find((r: AuthProbeResult) => r.provider === "test-none");
    expect(result).toBeUndefined();
  });

  it("reports no_model for apiKeyHelper provider without catalog match", async () => {
    const cfg = {
      models: {
        providers: {
          "unknown-provider": {
            baseUrl: "http://localhost",
            apiKeyHelper: "echo 'key'",
            models: [{ id: "some-model", name: "Some" }],
          },
        },
      },
    };

    const summary = await runAuthProbes({
      cfg: cfg as unknown as Parameters<typeof runAuthProbes>[0]["cfg"],
      providers: ["unknown-provider"],
      modelCandidates: [],
      options: baseOpts,
    });

    const result = summary.results.find((r: AuthProbeResult) => r.provider === "unknown-provider");
    expect(result).toBeDefined();
    expect(result!.source).toBe("apiKeyHelper");
    expect(result!.status).toBe("no_model");
  });
});
