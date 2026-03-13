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

vi.mock("../logging/diagnostic.js", () => ({
  getRecentDiagnosticEarlyStatusSummary: vi.fn(() => ({
    sampleCount: 3,
    eligibleCount: 1,
    semanticGateCount: 1,
    latencyGateCount: 1,
    topReasons: [{ reason: "latency_priority_observe", count: 1 }],
  })),
  getRecentDiagnosticLatencySummary: vi.fn(() => ({
    sampleCount: 2,
    dominant: [{ segment: "runToFirstVisible", count: 2 }],
    segments: {},
  })),
}));

vi.mock("../auto-reply/reply/supervisor/truthful-status-policy.js", () => ({
  buildTruthfulEarlyStatusGuidance: vi.fn(() => ({
    focus: "expand_active_run_status",
    reason: "recent_candidates_are_primarily_waiting_on_latency_priority_rather_than_semantics",
  })),
  recommendTruthfulEarlyStatusFromLatency: vi.fn(() => ({
    level: "prioritize",
    reason: "runtime_started_but_visible_feedback_arrives_late",
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
    expect(summary.heartbeat.diagnostics?.latency?.dominant).toEqual([
      { segment: "runToFirstVisible", count: 2 },
    ]);
    expect(summary.heartbeat.diagnostics?.latency?.earlyStatusPriority).toEqual({
      level: "prioritize",
      reason: "runtime_started_but_visible_feedback_arrives_late",
    });
    expect(summary.heartbeat.diagnostics?.earlyStatus).toEqual({
      sampleCount: 3,
      eligibleCount: 1,
      semanticGateCount: 1,
      latencyGateCount: 1,
      topReasons: [{ reason: "latency_priority_observe", count: 1 }],
      guidance: {
        focus: "expand_active_run_status",
        reason: "recent_candidates_are_primarily_waiting_on_latency_priority_rather_than_semantics",
      },
    });
  });
});
