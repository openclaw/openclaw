import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const runCliAgentMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const loadModelCatalogMock = vi.fn(async () => []);

let mockStore: AuthProfileStore = {
  version: 1,
  profiles: {},
  order: {},
};

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: () => mockStore,
    listProfilesForProvider: (_store: AuthProfileStore, provider: string) =>
      Object.entries(mockStore.profiles)
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId),
    resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
    resolveAuthProfileEligibility: () => ({ eligible: true }),
    resolveAuthProfileOrder: () => [],
  };
});

vi.mock("../../agents/model-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-auth.js")>();
  return {
    ...actual,
    resolveEnvApiKey: () => null,
    hasUsableCustomProviderApiKey: (_cfg: OpenClawConfig, provider: string) =>
      provider === "claude-cli",
  };
});

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: loadModelCatalogMock,
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (params: unknown) => runCliAgentMock(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: () => path.join(os.tmpdir(), "openclaw-probe-tests"),
  resolveSessionTranscriptPath: (sessionId: string) =>
    path.join(os.tmpdir(), "openclaw-probe-tests", `${sessionId}.jsonl`),
}));

const { runAuthProbes } = await import("./list.probe.js");

describe("runAuthProbes CLI backend dispatch", () => {
  beforeEach(() => {
    mockStore = {
      version: 1,
      profiles: {
        "claude-cli:default": {
          type: "token",
          provider: "claude-cli",
          token: "test-token",
        },
      },
      order: {},
    };
    runCliAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue([]);
  });

  it("probes CLI-backed models through runCliAgent", async () => {
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "OK" }],
      meta: {
        agentMeta: {
          sessionId: "cli-session",
          provider: "claude-cli",
          model: "opus",
        },
      },
    });

    const summary = await runAuthProbes({
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
      } as OpenClawConfig,
      providers: ["claude-cli"],
      modelCandidates: ["claude-cli/opus"],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt:
          "Reply with exactly OK and nothing else. Do not use tools. Keep the reply to at most 16 tokens.",
        sessionKey: expect.stringMatching(/^agent:main:probe-claude-cli-/),
        provider: "claude-cli",
        model: "opus",
        thinkLevel: "off",
        streamParams: { maxTokens: 16 },
        disableTools: true,
        cleanupCliLiveSessionOnRunEnd: true,
      }),
    );
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(summary.results).toEqual([
      expect.objectContaining({
        provider: "claude-cli",
        model: "claude-cli/opus",
        status: "ok",
      }),
    ]);
  });

  it("keeps canonical provider credential probes on the canonical provider", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "test-token",
        },
      },
      order: {},
    };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "OK" }],
      meta: {
        agentMeta: {
          sessionId: "embedded-session",
          provider: "anthropic",
          model: "opus",
        },
      },
    });

    await runAuthProbes({
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli" },
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
      } as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: ["anthropic/opus"],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.stringMatching(/^probe-anthropic-/),
        provider: "anthropic",
        model: "opus",
        authProfileId: "anthropic:default",
        cleanupBundleMcpOnRunEnd: true,
      }),
    );
  });

  it("uses CLI runtime profiles for canonical provider probes", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "claude-cli:default": {
          type: "token",
          provider: "claude-cli",
          token: "test-token",
        },
      },
      order: {},
    };
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "OK" }],
      meta: {
        agentMeta: {
          sessionId: "cli-session",
          provider: "claude-cli",
          model: "opus",
        },
      },
    });

    await runAuthProbes({
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "claude-cli" },
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
      } as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: ["claude-cli/opus"],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(/^agent:main:probe-anthropic-/),
        provider: "claude-cli",
        model: "opus",
        authProfileId: "claude-cli:default",
        cleanupCliLiveSessionOnRunEnd: true,
      }),
    );
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("uses a singular token label when the probe cap is one token", async () => {
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "OK" }],
      meta: {
        agentMeta: {
          sessionId: "cli-session",
          provider: "claude-cli",
          model: "opus",
        },
      },
    });

    await runAuthProbes({
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
      } as OpenClawConfig,
      providers: ["claude-cli"],
      modelCandidates: ["claude-cli/opus"],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 1,
      },
    });

    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt:
          "Reply with exactly OK and nothing else. Do not use tools. Keep the reply to at most 1 token.",
      }),
    );
  });

  it("keeps the embedded probe prompt unchanged for non-CLI providers", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "test-token",
        },
      },
      order: {},
    };
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "OK" }],
      meta: {
        agentMeta: {
          sessionId: "embedded-session",
          provider: "anthropic",
          model: "sonnet-4-6",
        },
      },
    });

    await runAuthProbes({
      cfg: {} as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: ["anthropic/sonnet-4-6"],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 1,
      },
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Reply with exactly OK and nothing else. Do not use tools.",
        streamParams: { maxTokens: 1 },
      }),
    );
  });
});
