import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../channels/config-presence.js", () => ({
  hasPotentialConfiguredChannels: vi.fn(() => true),
}));

vi.mock("./status.summary.runtime.js", () => ({
  statusSummaryRuntime: {
    classifySessionKey: vi.fn(() => "direct"),
    resolveSessionModelRef: vi.fn(() => ({
      provider: "openai",
      model: "gpt-5.2",
    })),
    resolveContextTokensForModel: vi.fn(() => 200_000),
  },
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200_000,
  DEFAULT_MODEL: "gpt-5.2",
  DEFAULT_PROVIDER: "openai",
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

const { hasPotentialConfiguredChannels } = await import("../channels/config-presence.js");
const { buildChannelSummary } = await import("../infra/channel-summary.js");
const { resolveLinkChannelContext } = await import("./status.link-channel.js");
const { statusSummaryRuntime } = await import("./status.summary.runtime.js");
const { getStatusSummary } = await import("./status.summary.js");

describe("getStatusSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes runtimeVersion in the status payload", async () => {
    const summary = await getStatusSummary();

    expect(summary.runtimeVersion).toBe("2026.3.8");
    expect(summary.heartbeat.defaultAgentId).toBe("main");
    expect(summary.channelSummary).toEqual(["ok"]);
  });

  it("skips channel summary imports when no channels are configured", async () => {
    vi.mocked(hasPotentialConfiguredChannels).mockReturnValue(false);

    const summary = await getStatusSummary();

    expect(summary.channelSummary).toEqual([]);
    expect(summary.linkChannel).toBeUndefined();
    expect(buildChannelSummary).not.toHaveBeenCalled();
    expect(resolveLinkChannelContext).not.toHaveBeenCalled();
  });

  it("does not trigger async context warmup while building status summaries", async () => {
    await getStatusSummary();

    expect(vi.mocked(statusSummaryRuntime.resolveContextTokensForModel)).toHaveBeenCalledWith(
      expect.objectContaining({ allowAsyncLoad: false }),
    );
  });
});
