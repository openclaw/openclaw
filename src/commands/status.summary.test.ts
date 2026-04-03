import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../channels/config-presence.js", () => ({
  hasPotentialConfiguredChannels: vi.fn(() => true),
}));

vi.mock("./status.summary.runtime.js", () => ({
  statusSummaryRuntime: {
    classifySessionKey: vi.fn(() => "direct"),
    resolveConfiguredStatusModelRef: vi.fn(() => ({
      provider: "openai",
      model: "gpt-5.2",
    })),
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

vi.mock("../config/io.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: vi.fn(() => ({})),
    resolveFreshSessionTotalTokens: vi.fn(() => undefined),
    resolveMainSessionKey: vi.fn(() => "main"),
    resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
  };
});

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

vi.mock("../logging/diagnostic.js", () => ({
  getRecentDiagnosticEarlyStatusSummary: vi.fn(() => ({
    sampleCount: 3,
    eligibleCount: 1,
    semanticGateCount: 1,
    latencyGateCount: 1,
    topReasons: [{ reason: "latency_priority_observe", count: 1 }],
    phase2Supplements: {
      sampleCount: 2,
      eligibleCount: 1,
      hitRatePct: 50,
      topSkipReasons: [{ reason: "latency_priority_observe", count: 1 }],
      statusFirstVisibleAvgMs: 800,
      statusFirstVisibleP95Ms: 950,
    },
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

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  getInspectableTaskRegistrySummary: vi.fn(() => ({
    total: 0,
    active: 0,
    terminal: 0,
    failures: 0,
    byStatus: {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: {
      subagent: 0,
      acp: 0,
      cli: 0,
      cron: 0,
    },
  })),
  getInspectableTaskAuditSummary: vi.fn(() => ({
    total: 1,
    warnings: 1,
    errors: 0,
    byCode: {
      stale_queued: 0,
      stale_running: 0,
      lost: 0,
      delivery_failed: 1,
      missing_cleanup: 0,
      inconsistent_timestamps: 0,
    },
  })),
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
let getStatusSummary: typeof import("./status.summary.js").getStatusSummary;
let statusSummaryRuntime: typeof import("./status.summary.runtime.js").statusSummaryRuntime;

describe("getStatusSummary", () => {
  beforeAll(async () => {
    ({ getStatusSummary } = await import("./status.summary.js"));
    ({ statusSummaryRuntime } = await import("./status.summary.runtime.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes runtimeVersion in the status payload", async () => {
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
      phase2Supplements: {
        sampleCount: 2,
        eligibleCount: 1,
        hitRatePct: 50,
        topSkipReasons: [{ reason: "latency_priority_observe", count: 1 }],
        statusFirstVisibleAvgMs: 800,
        statusFirstVisibleP95Ms: 950,
      },
    });
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
