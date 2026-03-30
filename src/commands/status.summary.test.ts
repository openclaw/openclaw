import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function loadStatusSummaryForTest() {
  vi.resetModules();
  const { getStatusSummary } = await import("./status.summary.js");
  const { statusSummaryRuntime } = await import("./status.summary.runtime.js");
  return { getStatusSummary, statusSummaryRuntime };
}

describe("getStatusSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes runtimeVersion in the status payload", async () => {
    const { getStatusSummary } = await loadStatusSummaryForTest();
    const summary = await getStatusSummary();

    expect(summary.runtimeVersion).toBe("2026.3.8");
    expect(summary.heartbeat.defaultAgentId).toBe("main");
    expect(summary.channelSummary).toEqual(["ok"]);
    expect(summary.tasks.active).toBe(0);
    expect(summary.taskAudit.warnings).toBe(1);
  });

  it("skips channel summary imports when no channels are configured", async () => {
    const { getStatusSummary } = await loadStatusSummaryForTest();
    vi.mocked(hasPotentialConfiguredChannels).mockReturnValue(false);

    const summary = await getStatusSummary();

    expect(summary.channelSummary).toEqual([]);
    expect(summary.linkChannel).toBeUndefined();
    expect(buildChannelSummary).not.toHaveBeenCalled();
    expect(resolveLinkChannelContext).not.toHaveBeenCalled();
  });

  it("does not trigger async context warmup while building status summaries", async () => {
    const { getStatusSummary, statusSummaryRuntime } = await loadStatusSummaryForTest();
    await getStatusSummary();

    expect(vi.mocked(statusSummaryRuntime.resolveContextTokensForModel)).toHaveBeenCalledWith(
      expect.objectContaining({ allowAsyncLoad: false }),
    );
  });
});
