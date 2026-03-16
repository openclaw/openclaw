import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../channels/config-presence.js", () => ({
  hasPotentialConfiguredChannels: vi.fn(() => true),
}));

vi.mock("../agents/context.js", () => ({
  resolveContextTokensForModel: vi.fn(() => 200_000),
  resolveContextTokensForModelAsync: vi.fn(async () => 200_000),
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200_000,
  DEFAULT_MODEL: "gpt-5.2",
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../agents/model-selection.js", () => ({
  resolveConfiguredModelRef: vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.2",
  })),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveFreshSessionTotalTokens: vi.fn(() => undefined),
  resolveMainSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
}));

vi.mock("../gateway/agent-list.js", () => ({
  listGatewayAgentsBasic: vi.fn(() => ({
    defaultId: "main",
    agents: [{ id: "main" }],
  })),
}));

vi.mock("../gateway/session-utils.js", () => ({
  classifySessionKey: vi.fn(() => "direct"),
  resolveSessionModelRef: vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.2",
  })),
}));

vi.mock("../infra/channel-summary.js", () => ({
  buildChannelSummary: vi.fn(async () => ["ok"]),
}));

vi.mock("../infra/heartbeat-summary.js", () => ({
  resolveHeartbeatSummaryForAgent: vi.fn(() => ({
    enabled: true,
    every: "5m",
    everyMs: 300_000,
  })),
}));

vi.mock("../infra/system-events.js", () => ({
  peekSystemEvents: vi.fn(() => []),
}));

vi.mock("../routing/session-key.js", () => ({
  normalizeAgentId: vi.fn((value: string) => value),
  normalizeMainKey: vi.fn((value?: string) => value ?? "main"),
  parseAgentSessionKey: vi.fn(() => null),
}));

vi.mock("../version.js", () => ({
  resolveRuntimeServiceVersion: vi.fn(() => "2026.3.8"),
}));

vi.mock("./status.link-channel.js", () => ({
  resolveLinkChannelContext: vi.fn(async () => undefined),
}));

describe("getStatusSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes runtimeVersion in the status payload", async () => {
    const { getStatusSummary } = await import("./status.summary.js");

    const summary = await getStatusSummary();

    expect(summary.runtimeVersion).toBe("2026.3.8");
    expect(summary.heartbeat.defaultAgentId).toBe("main");
    expect(summary.channelSummary).toEqual(["ok"]);
  });

  it("skips channel summary imports when no channels are configured", async () => {
    const { hasPotentialConfiguredChannels } = await import("../channels/config-presence.js");
    vi.mocked(hasPotentialConfiguredChannels).mockReturnValue(false);
    const { buildChannelSummary } = await import("../infra/channel-summary.js");
    const { resolveLinkChannelContext } = await import("./status.link-channel.js");
    const { getStatusSummary } = await import("./status.summary.js");

    const summary = await getStatusSummary();

    expect(summary.channelSummary).toEqual([]);
    expect(summary.linkChannel).toBeUndefined();
    expect(buildChannelSummary).not.toHaveBeenCalled();
    expect(resolveLinkChannelContext).not.toHaveBeenCalled();
  });

  it("repairs stale stored fallback context tokens when the model registry resolves a larger window", async () => {
    const { resolveContextTokensForModelAsync } = await import("../agents/context.js");
    const { loadSessionStore } = await import("../config/sessions.js");
    const { resolveSessionModelRef } = await import("../gateway/session-utils.js");
    const { getStatusSummary } = await import("./status.summary.js");

    vi.mocked(resolveContextTokensForModelAsync).mockImplementation(async (params) => {
      if (params.model === "claude-opus-4-6") {
        return 1_000_000;
      }
      return 200_000;
    });
    vi.mocked(resolveSessionModelRef).mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:main:cron:test": {
        sessionId: "sess-cron",
        updatedAt: Date.now(),
        model: "claude-opus-4-6",
        modelProvider: "anthropic",
        contextTokens: 200_000,
      },
    });

    const summary = await getStatusSummary({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      },
    });

    expect(summary.sessions.recent[0]?.contextTokens).toBe(1_000_000);
  });
});
