import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const statusSummaryMocks = vi.hoisted(() => ({
  hasPotentialConfiguredChannels: vi.fn(() => true),
  buildChannelSummary: vi.fn(async () => ["ok"]),
  listGatewayAgentsBasic: vi.fn(() => ({
    defaultId: "main",
    agents: [{ id: "main" }],
  })),
  resolveHeartbeatSummaryForAgent: vi.fn(() => ({
    enabled: true,
    every: "5m",
    everyMs: 300_000,
  })),
  getLastHeartbeatEvent: vi.fn(() => null),
}));

vi.mock("../channels/config-presence.js", () => ({
  hasPotentialConfiguredChannels: statusSummaryMocks.hasPotentialConfiguredChannels,
}));

vi.mock("./status.summary.runtime.js", () => ({
  statusSummaryRuntime: {
    classifySessionKey: vi.fn(() => "direct"),
    resolveConfiguredStatusModelRef: vi.fn(() => ({
      provider: "openai",
      model: "gpt-5.4",
    })),
    resolveSessionModelRef: vi.fn(() => ({
      provider: "openai",
      model: "gpt-5.4",
    })),
    resolveContextTokensForModel: vi.fn(() => 200_000),
  },
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200_000,
  DEFAULT_MODEL: "gpt-5.4",
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../config/io.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../gateway/agent-list.js", () => ({
  listGatewayAgentsBasic: statusSummaryMocks.listGatewayAgentsBasic,
}));

vi.mock("../infra/channel-summary.js", () => ({
  buildChannelSummary: statusSummaryMocks.buildChannelSummary,
}));

vi.mock("../infra/heartbeat-summary.js", () => ({
  resolveHeartbeatSummaryForAgent: statusSummaryMocks.resolveHeartbeatSummaryForAgent,
}));

vi.mock("../infra/heartbeat-events.js", () => ({
  getLastHeartbeatEvent: statusSummaryMocks.getLastHeartbeatEvent,
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

vi.mock("../version.js", async () => {
  const actual = await vi.importActual<typeof import("../version.js")>("../version.js");
  return {
    ...actual,
    resolveRuntimeServiceVersion: vi.fn(() => "2026.3.8"),
  };
});

vi.mock("./status.link-channel.js", () => ({
  resolveLinkChannelContext: vi.fn(async () => undefined),
}));

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
    statusSummaryMocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    statusSummaryMocks.buildChannelSummary.mockResolvedValue(["ok"]);
    statusSummaryMocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "main",
      agents: [{ id: "main" }],
    });
    statusSummaryMocks.resolveHeartbeatSummaryForAgent.mockReturnValue({
      enabled: true,
      every: "5m",
      everyMs: 300_000,
    });
    statusSummaryMocks.getLastHeartbeatEvent.mockReturnValue(null);
  });

  it("includes runtimeVersion in the status payload", async () => {
    const summary = await getStatusSummary();

    expect(summary.runtimeVersion).toBe("2026.3.8");
    expect(summary.heartbeat.defaultAgentId).toBe("main");
    expect(summary.channelSummary).toEqual(["ok"]);
    expect(summary.tasks.active).toBe(0);
    expect(summary.taskAudit.warnings).toBe(1);
  });

  it("marks enabled heartbeat agents as running when a recent tick was observed", async () => {
    const now = Date.now();
    statusSummaryMocks.getLastHeartbeatEvent.mockReturnValue({
      ts: now - 60_000,
      status: "ok",
      channel: "telegram",
      accountId: "default",
    });

    const summary = await getStatusSummary();

    expect(summary.heartbeat.agents).toEqual([
      expect.objectContaining({
        agentId: "main",
        enabled: true,
        observedState: "running",
        lastTickTs: now - 60_000,
      }),
    ]);
  });

  it("marks enabled heartbeat agents as stale when the last observed tick is too old", async () => {
    const now = Date.now();
    statusSummaryMocks.getLastHeartbeatEvent.mockReturnValue({
      ts: now - 700_000,
      status: "ok",
      channel: "telegram",
    });

    const summary = await getStatusSummary();

    expect(summary.heartbeat.agents).toEqual([
      expect.objectContaining({
        agentId: "main",
        enabled: true,
        observedState: "stale",
        lastTickTs: now - 700_000,
      }),
    ]);
  });

  it("keeps disabled agents disabled even when another agent heartbeat was observed", async () => {
    statusSummaryMocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "main",
      agents: [{ id: "main" }, { id: "devclaw" }],
    });
    statusSummaryMocks.resolveHeartbeatSummaryForAgent.mockImplementation(
      (_cfg: unknown, agentId: string) =>
        agentId === "devclaw"
          ? { enabled: false, every: "disabled", everyMs: null }
          : { enabled: true, every: "30m", everyMs: 1_800_000 },
    );
    statusSummaryMocks.getLastHeartbeatEvent.mockReturnValue({
      ts: Date.now() - 60_000,
      status: "ok",
      channel: "telegram",
    });

    const summary = await getStatusSummary();

    expect(summary.heartbeat.agents).toEqual([
      expect.objectContaining({
        agentId: "main",
        enabled: true,
        observedState: "running",
      }),
      expect.objectContaining({
        agentId: "devclaw",
        enabled: false,
        observedState: undefined,
        lastTickTs: null,
      }),
    ]);
  });

  it("skips channel summary imports when no channels are configured", async () => {
    statusSummaryMocks.hasPotentialConfiguredChannels.mockReturnValue(false);

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
