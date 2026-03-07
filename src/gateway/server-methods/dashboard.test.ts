import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncidentManager } from "../incident-manager.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  listDevicePairing: vi.fn(),
  getTotalQueueSize: vi.fn(),
  getTotalPendingReplies: vi.fn(),
  getActiveEmbeddedRunCount: vi.fn(),
  runSecurityAudit: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../infra/device-pairing.js", () => ({
  listDevicePairing: mocks.listDevicePairing,
}));

vi.mock("../../process/command-queue.js", () => ({
  getTotalQueueSize: mocks.getTotalQueueSize,
}));

vi.mock("../../auto-reply/reply/dispatcher-registry.js", () => ({
  getTotalPendingReplies: mocks.getTotalPendingReplies,
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  getActiveEmbeddedRunCount: mocks.getActiveEmbeddedRunCount,
}));

vi.mock("../../security/audit.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

async function loadDashboardModule() {
  return await import("./dashboard.js");
}

async function loadHandlers() {
  const mod = await loadDashboardModule();
  return mod.dashboardHandlers;
}

function createContext() {
  return {
    execApprovalManager: {
      listPending: () => [
        {
          id: "approval-1",
          request: {
            command: "git pull",
            agentId: "main",
            sessionKey: "main",
          },
          expiresAtMs: 2_000,
        },
      ],
    },
    nodeRegistry: {
      listConnected: () => [{ id: "node-1" }, { id: "node-2" }],
    },
    incidentManager: new IncidentManager(),
    hasConnectedMobileNode: () => true,
    broadcast: vi.fn(),
    logGateway: {
      warn: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.loadConfig.mockReturnValue({ gateway: {} });
  mocks.listDevicePairing.mockResolvedValue({
    pending: [{ requestId: "pair-1" }],
    paired: [{ deviceId: "paired-1" }, { deviceId: "paired-2" }],
  });
  mocks.getTotalQueueSize.mockReturnValue(4);
  mocks.getTotalPendingReplies.mockReturnValue(2);
  mocks.getActiveEmbeddedRunCount.mockReturnValue(1);
  mocks.runSecurityAudit.mockResolvedValue({
    ts: 1_111,
    summary: {
      critical: 1,
      warn: 2,
      info: 3,
    },
    findings: [
      {
        severity: "warn",
        title: "Webhook origin broad",
        detail: "Allowed origins contain a wildcard.",
        remediation: "Restrict allowed origins.",
      },
      {
        severity: "info",
        title: "Rotate keys",
        detail: "Keys are older than 30 days.",
      },
      {
        severity: "critical",
        title: "Shared token enabled",
        detail: "A shared operator token is active.",
        remediation: "Move to device-bound auth.",
      },
    ],
  });
});

describe("dashboard.summary", () => {
  it("returns a combined operations snapshot", async () => {
    const handlers = await loadHandlers();
    const respond = vi.fn();

    await handlers["dashboard.summary"]({
      respond,
      context: createContext() as Parameters<(typeof handlers)["dashboard.summary"]>[0]["context"],
      params: {},
    } as Parameters<(typeof handlers)["dashboard.summary"]>[0]);

    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
    });

    const payload = respond.mock.calls[0]?.[1];
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(payload.approvals.count).toBe(1);
    expect(payload.devices).toEqual({ pending: 1, paired: 2 });
    expect(payload.nodes).toEqual({ count: 2, hasMobileNodeConnected: true });
    expect(payload.runtime).toEqual({
      queueSize: 4,
      pendingReplies: 2,
      activeEmbeddedRuns: 1,
    });
    expect(payload.incidents.summary.active).toBeGreaterThan(0);
    expect(payload.incidents.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "approval:approval-1",
          status: "open",
        }),
        expect.objectContaining({
          id: "security:Shared token enabled",
          severity: "critical",
        }),
      ]),
    );
    expect(payload.security.summary).toEqual({ critical: 1, warn: 2, info: 3 });
    expect(payload.security.cached).toBe(false);
    expect(payload.security.topFindings).toEqual([
      expect.objectContaining({
        severity: "critical",
        title: "Shared token enabled",
      }),
      expect.objectContaining({
        severity: "warn",
        title: "Webhook origin broad",
      }),
    ]);
  });

  it("reuses the cached security audit between summary calls", async () => {
    const handlers = await loadHandlers();
    const respond = vi.fn();

    await handlers["dashboard.summary"]({
      respond,
      context: createContext() as Parameters<(typeof handlers)["dashboard.summary"]>[0]["context"],
      params: {},
    } as Parameters<(typeof handlers)["dashboard.summary"]>[0]);

    await handlers["dashboard.summary"]({
      respond,
      context: createContext() as Parameters<(typeof handlers)["dashboard.summary"]>[0]["context"],
      params: {},
    } as Parameters<(typeof handlers)["dashboard.summary"]>[0]);

    expect(mocks.runSecurityAudit).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[1].security.cached).toBe(false);
    expect(respond.mock.calls[1]?.[1].security.cached).toBe(true);
  });

  it("reruns the audit when forceAudit is requested", async () => {
    const handlers = await loadHandlers();
    const respond = vi.fn();

    await handlers["dashboard.summary"]({
      respond,
      context: createContext() as Parameters<(typeof handlers)["dashboard.summary"]>[0]["context"],
      params: {},
    } as Parameters<(typeof handlers)["dashboard.summary"]>[0]);

    await handlers["dashboard.summary"]({
      respond,
      context: createContext() as Parameters<(typeof handlers)["dashboard.summary"]>[0]["context"],
      params: { forceAudit: true },
    } as Parameters<(typeof handlers)["dashboard.summary"]>[0]);

    expect(mocks.runSecurityAudit).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]?.[1].security.cached).toBe(false);
  });

  it("broadcasts dashboard.delta with the current snapshot", async () => {
    const mod = await loadDashboardModule();
    const context = createContext();

    const payload = await mod.broadcastDashboardDelta(
      context as Parameters<typeof mod.broadcastDashboardDelta>[0],
    );

    expect(payload?.approvals.count).toBe(1);
    expect(context.broadcast).toHaveBeenCalledWith(
      "dashboard.delta",
      expect.objectContaining({
        devices: { pending: 1, paired: 2 },
        runtime: { queueSize: 4, pendingReplies: 2, activeEmbeddedRuns: 1 },
      }),
      { dropIfSlow: true },
    );
  });

  it("throttles scheduled dashboard.delta broadcasts", async () => {
    vi.useFakeTimers();
    try {
      const mod = await loadDashboardModule();
      const context = createContext();

      mod.scheduleDashboardDelta(context as Parameters<typeof mod.scheduleDashboardDelta>[0], 250);
      mod.scheduleDashboardDelta(context as Parameters<typeof mod.scheduleDashboardDelta>[0], 250);

      await vi.advanceTimersByTimeAsync(250);

      expect(context.broadcast).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
