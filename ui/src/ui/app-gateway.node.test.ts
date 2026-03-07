import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectGateway } from "./app-gateway.ts";

type GatewayClientMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emitClose: (code: number, reason?: string) => void;
  emitGap: (expected: number, received: number) => void;
  emitEvent: (evt: { event: string; payload?: unknown; seq?: number }) => void;
};

const gatewayClientInstances = vi.hoisted(() => [] as GatewayClientMock[]);
const loadDashboardSummaryMock = vi.hoisted(() => vi.fn());
const captureDashboardTimelineMock = vi.hoisted(() => vi.fn());
const handleAgentEventMock = vi.hoisted(() => vi.fn());
const resumeMissionNodeRunMock = vi.hoisted(() => vi.fn());

vi.mock("./gateway.ts", () => {
  class GatewayBrowserClient {
    readonly start = vi.fn();
    readonly stop = vi.fn();

    constructor(
      private opts: {
        onClose?: (info: { code: number; reason: string }) => void;
        onGap?: (info: { expected: number; received: number }) => void;
        onEvent?: (evt: { event: string; payload?: unknown; seq?: number }) => void;
      },
    ) {
      gatewayClientInstances.push({
        start: this.start,
        stop: this.stop,
        emitClose: (code, reason) => {
          this.opts.onClose?.({ code, reason: reason ?? "" });
        },
        emitGap: (expected, received) => {
          this.opts.onGap?.({ expected, received });
        },
        emitEvent: (evt) => {
          this.opts.onEvent?.(evt);
        },
      });
    }
  }

  return { GatewayBrowserClient };
});

vi.mock("./controllers/dashboard.ts", () => ({
  loadDashboardSummary: loadDashboardSummaryMock,
  applyDashboardSummary: (
    state: {
      dashboardSummary: unknown;
      dashboardError: string | null;
      execApprovalQueue: unknown[];
    },
    summary: { approvals?: { pending?: unknown[] } },
  ) => {
    state.dashboardSummary = summary;
    state.dashboardError = null;
    if (Array.isArray(summary.approvals?.pending)) {
      state.execApprovalQueue = summary.approvals.pending;
    }
  },
}));

vi.mock("./controllers/dashboard-timeline.ts", () => ({
  captureDashboardTimeline: captureDashboardTimelineMock,
}));

vi.mock("./app-tool-stream.ts", () => ({
  handleAgentEvent: handleAgentEventMock,
  resetToolStream: vi.fn(),
}));

vi.mock("./controllers/mission-control.ts", () => ({
  resumeMissionNodeRun: resumeMissionNodeRunMock,
}));

function createHost() {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    },
    password: "",
    client: null,
    connected: false,
    hello: null,
    lastError: null,
    eventLogBuffer: [],
    eventLog: [],
    tab: "overview",
    presenceEntries: [],
    presenceError: null,
    presenceStatus: null,
    agentsLoading: false,
    agentsList: null,
    agentsError: null,
    debugHealth: null,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    sessionKey: "main",
    chatRunId: null,
    refreshSessionsAfterChat: new Set<string>(),
    dashboardSummary: null,
    dashboardError: null,
    dashboardTimeline: [],
    execApprovalQueue: [],
    execApprovalError: null,
    missionNodePendingRuns: {},
    missionNodeBusyById: {},
    missionNodeResult: null,
  } as unknown as Parameters<typeof connectGateway>[0];
}

describe("connectGateway", () => {
  beforeEach(() => {
    gatewayClientInstances.length = 0;
    loadDashboardSummaryMock.mockReset();
    captureDashboardTimelineMock.mockReset();
    handleAgentEventMock.mockReset();
    resumeMissionNodeRunMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores stale client onGap callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitGap(10, 13);
    expect(host.lastError).toBeNull();

    secondClient.emitGap(20, 24);
    expect(host.lastError).toBe(
      "event gap detected (expected seq 20, got 24); refresh recommended",
    );
  });

  it("ignores stale client onEvent callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitEvent({ event: "presence", payload: { presence: [{ host: "stale" }] } });
    expect(host.eventLogBuffer).toHaveLength(0);

    secondClient.emitEvent({ event: "presence", payload: { presence: [{ host: "active" }] } });
    expect(host.eventLogBuffer).toHaveLength(1);
    expect(host.eventLogBuffer[0]?.event).toBe("presence");
  });

  it("ignores stale client onClose callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitClose(1005);
    expect(host.lastError).toBeNull();

    secondClient.emitClose(1005);
    expect(host.lastError).toBe("disconnected (1005): no reason");
  });

  it("applies dashboard delta payload immediately", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    host.connected = true;

    client.emitEvent({
      event: "dashboard.delta",
      payload: {
        ts: Date.now(),
        security: {
          ts: Date.now(),
          cached: true,
          summary: { critical: 1, warn: 2, info: 0 },
          topFindings: [],
        },
        approvals: {
          count: 1,
          pending: [
            {
              id: "approval-1",
              request: {
                command: "git pull",
                agentId: "main",
                sessionKey: "main",
              },
              expiresAtMs: Date.now() + 60_000,
            },
          ],
        },
        devices: { pending: 2, paired: 3 },
        nodes: { count: 4, hasMobileNodeConnected: true },
        runtime: { queueSize: 5, pendingReplies: 1, activeEmbeddedRuns: 2 },
      },
    });

    expect((host as unknown as { dashboardSummary: unknown }).dashboardSummary).toEqual(
      expect.objectContaining({
        runtime: { queueSize: 5, pendingReplies: 1, activeEmbeddedRuns: 2 },
      }),
    );
    expect(host.execApprovalQueue).toHaveLength(1);
    expect(loadDashboardSummaryMock).not.toHaveBeenCalled();
    expect(captureDashboardTimelineMock).toHaveBeenCalledTimes(1);
  });

  it("does not refetch dashboard summary for operator delta events", async () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    host.connected = true;

    client.emitEvent({
      event: "exec.approval.requested",
      payload: {
        id: "approval-1",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        request: {
          command: "git pull",
          agentId: "main",
          sessionKey: "main",
        },
      },
    });
    client.emitEvent({
      event: "device.pair.requested",
      payload: {
        requestId: "pair-1",
      },
    });

    await vi.advanceTimersByTimeAsync(900);

    expect(loadDashboardSummaryMock).not.toHaveBeenCalled();
  });

  it("throttles dashboard summary refresh after lifecycle events", async () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();
    host.connected = true;

    client.emitEvent({
      event: "agent",
      payload: {
        runId: "run-1",
        stream: "lifecycle",
        data: { phase: "start" },
      },
    });
    client.emitEvent({
      event: "agent",
      payload: {
        runId: "run-1",
        stream: "lifecycle",
        data: { phase: "end" },
      },
    });

    expect(loadDashboardSummaryMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(900);

    expect(loadDashboardSummaryMock).toHaveBeenCalledTimes(1);
  });

  it("resumes pending mission node runs after approval resolution", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    host.execApprovalQueue = [
      {
        id: "approval-1",
        request: {
          command: "openclaw doctor --non-interactive",
          agentId: "main",
          sessionKey: "main",
        },
        expiresAtMs: Date.now() + 60_000,
      },
    ] as typeof host.execApprovalQueue;

    client.emitEvent({
      event: "exec.approval.resolved",
      payload: {
        id: "approval-1",
        decision: "allow-once",
      },
    });

    expect(host.execApprovalQueue).toHaveLength(0);
    expect(resumeMissionNodeRunMock).toHaveBeenCalledTimes(1);
    expect(resumeMissionNodeRunMock).toHaveBeenCalledWith(host, "approval-1", "allow-once");
  });
});
