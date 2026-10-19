import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
// mock-isolation: Assert Gateway projection avoids local agent discovery.
vi.mock("./status.agent-local.js", () => ({ collectStatusLocalSnapshot: mocks.localAgents }));
// mock-isolation: Gateway projection tests must not read local session databases.
vi.mock("../status/summary.js", () => ({
  getStatusSummary: mocks.localSummary,
  prepareStatusSummary: async (...args: unknown[]) => {
    const summary = await mocks.localSummary(...args);
    return { publish: () => ({ summary, sessionStores: undefined }) };
  },
}));
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
// mock-isolation: Supply reachable/offline Gateway facts without network access.
vi.mock("../gateway/probe.js", () => ({ probeGateway: mocks.probeGateway }));
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
    auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
    status: null,
    presence: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const scan = () =>
  scanStatusJsonFast(createStatusGatewayProbeBudget(), {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  });

it.each([
  { withProjection: false, remote: false, readinessElapsedMs: 0, withChannelSummary: false },
  { withProjection: true, remote: false, readinessElapsedMs: 0, withChannelSummary: false },
  { withProjection: true, remote: true, readinessElapsedMs: 0, withChannelSummary: false },
  { withProjection: true, remote: false, readinessElapsedMs: 22_000, withChannelSummary: false },
  { withProjection: true, remote: false, readinessElapsedMs: 0, withChannelSummary: true },
])(
  "serves online fleet JSON without local discovery ($withProjection, remote: $remote, startup: $readinessElapsedMs, channels: $withChannelSummary)",
  async ({ withProjection, remote, readinessElapsedMs, withChannelSummary }) => {
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
          channelSummary: withChannelSummary ? ["Telegram: configured"] : [],
          sessions: {
            count: 7,
            byAgent: [
              { agentId: "alpha", path: "[redacted]", count: 3, recent: [] },
              { agentId: "beta", path: "[redacted]", count: 4, recent: [] },
            ],
          },
        };
        mocks.callGateway.mockResolvedValue(summary);

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
        const result = await scan();

        expect(mocks.fullConfigReads).toBe(0);
        expect(mocks.localAgents).not.toHaveBeenCalled();
        expect(mocks.localSummary).not.toHaveBeenCalled();
        expect(result.summary.sessions).toEqual(summary.sessions);
        expect(result.summary).not.toHaveProperty("cliProjection");
        expect(result.agentStatus).toMatchObject({
          totalSessions: 7,
          bootstrapPendingCount: null,
          defaultId: null,
          ownership: withProjection ? "explicit" : null,
        });
        expect(result.cfg.update?.channel).toBe(withProjection && !remote ? "beta" : undefined);
        expect(result.agentStatus.agents[0]?.name).toBe(withProjection ? "Alpha" : undefined);
        expect(
          result.collection?.notCollected.filter((entry) =>
            entry.fields.includes("channelSummary"),
          ),
        ).toEqual(
          withChannelSummary ? [] : [expect.objectContaining({ fields: ["channelSummary"] })],
        );
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

it("marks channelSummary uncollected when Gateway status projection fails", async () => {
  await withOpenClawTestState(
    { layout: "split", prefix: "status-gateway-projection-failed-" },
    async (state) => {
      await state.writeConfig({
        gateway: { mode: "local", auth: { mode: "none" } },
        plugins: { enabled: false },
      });
      mocks.callGateway.mockRejectedValue(new Error("status rpc failed"));

      const result = await scan();

      expect(result.gatewayReachable).toBe(true);
      expect(result.summary.channelSummary).toEqual([]);
      expect(
        result.collection?.notCollected.filter((entry) => entry.fields.includes("channelSummary")),
      ).toEqual([
        expect.objectContaining({
          fields: expect.arrayContaining(["sessions"]),
          reason: "status rpc failed",
        }),
      ]);
    },
  );
});

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
      mocks.localAgents.mockResolvedValue({
        defaultId: local.defaultId,
        publish: () => local,
        sessionStores: undefined,
      });
      mocks.localSummary.mockResolvedValue({ sessions: { count: 4 }, heartbeat: { agents: [] } });

      const result = await scan();

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
