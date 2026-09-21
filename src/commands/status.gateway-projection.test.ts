import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyTaskAuditSummary } from "../tasks/task-registry.audit.shared.js";
import { createEmptyTaskRegistrySummary } from "../tasks/task-registry.summary.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import { scanStatusJsonFast } from "./status.scan.fast-json.js";

const mocks = vi.hoisted(() => ({
  fullConfigReads: 0,
  localAgents: vi.fn(),
  localSummary: vi.fn(),
  callGateway: vi.fn(),
  probeGateway: vi.fn(),
  waitForGatewayDiagnosticReadiness: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshotWithPluginMetadata: async (
      ...args: Parameters<typeof actual.readConfigFileSnapshotWithPluginMetadata>
    ) => {
      mocks.fullConfigReads++;
      return actual.readConfigFileSnapshotWithPluginMetadata(...args);
    },
  };
});
vi.mock("./status.agent-local.js", () => ({
  collectStatusLocalSnapshot: mocks.localAgents,
}));
vi.mock("../status/summary.js", () => ({ getStatusSummary: mocks.localSummary }));
vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return {
    callGateway: mocks.callGateway,
    isImplicitLocalGatewayTarget: actual.isImplicitLocalGatewayTarget,
  };
});
vi.mock("./status.update.js", () => ({
  getUpdateCheckResult: async () => ({
    root: null,
    installKind: "unknown",
    packageManager: "unknown",
  }),
}));
vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));
vi.mock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: mocks.waitForGatewayDiagnosticReadiness,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(performance, "now").mockReturnValue(0);
  mocks.waitForGatewayDiagnosticReadiness.mockReset();
  mocks.fullConfigReads = 0;
  mocks.probeGateway.mockResolvedValue({
    ok: true,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: 1,
    error: null,
    close: null,
    auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
    status: null,
    health: null,
    presence: [],
    configSnapshot: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([
  { withProjection: false, remote: false, readinessElapsedMs: 0 },
  { withProjection: true, remote: false, readinessElapsedMs: 0 },
  { withProjection: true, remote: true, readinessElapsedMs: 0 },
  { withProjection: true, remote: false, readinessElapsedMs: 22_000 },
])(
  "serves online fleet JSON without local discovery ($withProjection, remote: $remote, startup: $readinessElapsedMs)",
  async ({ withProjection, remote, readinessElapsedMs }) => {
    await withOpenClawTestState(
      { layout: "split", prefix: "status-gateway-projection-" },
      async (state) => {
        await state.writeConfig({
          gateway: {
            mode: remote ? "remote" : "local",
            auth: { mode: "none" },
            ...(remote ? { remote: { url: "wss://gateway.example.test" } } : {}),
          },
          plugins: { enabled: false },
          agents: {
            ownership: "explicit",
            entries: {
              alpha: { workspace: state.path("alpha") },
              beta: { workspace: state.path("beta") },
            },
          },
        });
        const summary = {
          ...(withProjection
            ? {
                cliProjection: {
                  agents: {
                    defaultId: null,
                    ownership: "explicit",
                    selectionRequired: true,
                    rows: [{ id: "alpha", name: "Alpha" }, { id: "beta" }],
                  },
                  updateChannel: "beta",
                  memoryPlugin: { enabled: false, slot: null, reason: "plugins disabled" },
                },
              }
            : {}),
          heartbeat: { defaultAgentId: "alpha", agents: [] },
          channelSummary: [],
          queuedSystemEvents: [],
          tasks: createEmptyTaskRegistrySummary(),
          taskAudit: createEmptyTaskAuditSummary(),
          sessions: {
            paths: [],
            count: 7,
            defaults: { model: null, contextTokens: null },
            recent: [],
            byAgent: [
              { agentId: "alpha", path: "[redacted]", count: 3, recent: [] },
              { agentId: "beta", path: "[redacted]", count: 4, recent: [] },
            ],
          },
        };
        mocks.callGateway.mockResolvedValue(summary);
        mocks.localAgents.mockResolvedValue({
          agentStatus: {
            defaultId: null,
            ownership: "explicit",
            selectionRequired: true,
            agents: [],
            totalSessions: 99,
            bootstrapPendingCount: 0,
          },
          sessionStores: undefined,
        });
        mocks.localSummary.mockResolvedValue({
          ...summary,
          sessions: { ...summary.sessions, count: 99 },
        });

        const clock = vi.spyOn(performance, "now");
        if (readinessElapsedMs) {
          mocks.waitForGatewayDiagnosticReadiness.mockImplementationOnce(async () => {
            clock.mockReturnValue(readinessElapsedMs);
            return { healthy: true, elapsedMs: readinessElapsedMs, waitOutcome: "healthy" };
          });
          mocks.probeGateway.mockImplementationOnce(async () => {
            clock.mockReturnValue(readinessElapsedMs + 1000);
            return { ok: true, connectLatencyMs: 1, error: null, status: null, presence: [] };
          });
        }
        const result = await scanStatusJsonFast(createStatusGatewayProbeBudget(), {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        });

        expect(mocks.fullConfigReads).toBe(0);
        expect(mocks.localAgents).not.toHaveBeenCalled();
        expect(mocks.localSummary).not.toHaveBeenCalled();
        expect(result.summary.sessions).toEqual(summary.sessions);
        expect(result.agentStatus.totalSessions).toBe(7);
        expect(result.summary).not.toHaveProperty("cliProjection");
        expect(result.agentStatus.bootstrapPendingCount).toBeNull();
        expect(result.agentStatus.defaultId).toBeNull();
        expect(result.agentStatus.ownership).toBe(withProjection ? "explicit" : null);
        expect(result.cfg.update?.channel).toBe(withProjection && !remote ? "beta" : undefined);
        expect(result.agentStatus.agents[0]?.name).toBe(withProjection ? "Alpha" : undefined);
        expect(result.collection?.notCollected.length).toBeGreaterThan(0);
        expect(mocks.callGateway).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "status",
            params: { includeChannelSummary: false, includeCliProjection: true },
            timeoutMs: readinessElapsedMs ? 37_000 : 60_000,
          }),
        );
      },
    );
  },
);

it("keeps offline config diagnostics and local collection", async () => {
  await withOpenClawTestState(
    { layout: "split", prefix: "status-gateway-offline-" },
    async (state) => {
      await state.writeConfig({
        gateway: { mode: "local" },
        plugins: { enabled: false },
        nodeHost: { browserProxy: { enabled: "invalid" } },
      });
      mocks.probeGateway.mockResolvedValue({
        ok: false,
        error: "offline",
        auth: { capability: "unknown" },
      });
      mocks.callGateway.mockRejectedValue(new Error("offline"));
      const local = {
        defaultId: "main",
        ownership: "sole",
        selectionRequired: false,
        agents: [],
        totalSessions: 4,
        bootstrapPendingCount: 0,
      };
      mocks.localAgents.mockResolvedValue({ agentStatus: local, sessionStores: undefined });
      mocks.localSummary.mockResolvedValue({ sessions: { count: 4 }, heartbeat: { agents: [] } });

      const result = await scanStatusJsonFast(createStatusGatewayProbeBudget(), {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      });

      expect(mocks.fullConfigReads).toBe(1);
      expect(mocks.localAgents).toHaveBeenCalledOnce();
      expect(mocks.localSummary).toHaveBeenCalledOnce();
      expect(result.agentStatus).toEqual(local);
      expect(result.gatewayReachable).toBe(false);
      expect(mocks.waitForGatewayDiagnosticReadiness).toHaveBeenCalledOnce();
      expect(result.collection).toBeUndefined();
      expect(result.configDiagnostics?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "nodeHost.browserProxy.enabled" }),
        ]),
      );
    },
  );
});
