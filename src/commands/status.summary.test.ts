import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/context.js", () => ({
  resolveContextTokensForModel: vi.fn(() => 200_000),
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

vi.mock("../gateway/session-utils.js", () => ({
  classifySessionKey: vi.fn(() => "direct"),
  listAgentsForGateway: vi.fn(() => ({
    defaultId: "main",
    agents: [{ id: "main" }],
  })),
  resolveSessionModelRef: vi.fn(() => ({
    provider: "openai",
    model: "gpt-5.2",
  })),
}));

vi.mock("../infra/channel-summary.js", () => ({
  buildChannelSummary: vi.fn(async () => ["ok"]),
}));

vi.mock("../infra/heartbeat-runner.js", () => ({
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
});
