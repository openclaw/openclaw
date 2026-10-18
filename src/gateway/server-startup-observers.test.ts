import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  historyLane,
  maintenanceLane,
  type SessionHistoryWorkerLane,
} from "../config/sessions/session-transcript-worker-resources.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { runGatewayStartupObservers } from "./server-startup-observers.js";

const mocks = vi.hoisted(() => ({
  prewarm: vi.fn<(database: unknown, lane?: SessionHistoryWorkerLane) => Promise<void>>(),
  activate: vi.fn(async () => {}),
  refresh: vi.fn(async () => null),
}));

// mock-isolation: Reader custody does not start the restored-run or update owners.
vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
  activateSubagentRegistry: mocks.activate,
}));
vi.mock("./server-update-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-update-sentinel.js")>()),
  prepareLatestUpdateRestartSentinel: mocks.refresh,
}));

vi.mock("node:fs/promises", () => ({
  default: { stat: async () => ({ isFile: () => true }) },
}));

// mock-isolation: Synthetic store discovery keeps startup readiness independent of SQLite admission.
vi.mock("../config/sessions/session-sqlite-target.js", () => ({
  prepareSqliteTargetFromSessionStorePath: async () => ({
    agentId: "main",
    path: "/synthetic/main/openclaw-agent.sqlite",
  }),
}));

// mock-isolation: Exercise startup custody without allocating native history readers.
vi.mock("../config/sessions/session-transcript-worker-runtime.js", () => ({
  isSessionHistoryWorkerCold: () => true,
  prewarmSessionHistoryWorker: mocks.prewarm,
}));

// mock-isolation: Watch-notice persistence is independent of restored-run admission.
vi.mock("../sessions/session-state-events.js", () => ({
  sweepSessionStateWatchNotices: vi.fn(async () => {}),
}));

beforeEach(() => {
  mocks.prewarm.mockReset();
  mocks.activate.mockClear();
  mocks.refresh.mockClear();
});
afterEach(() => resetGatewayWorkAdmission());

it.each([
  { reader: "history", lane: historyLane, outcome: "activate" },
  { reader: "history", lane: historyLane, outcome: "close" },
  { reader: "maintenance", lane: maintenanceLane, outcome: "activate" },
  { reader: "maintenance", lane: maintenanceLane, outcome: "close" },
])(
  "joins $reader preparation before restored recovery can $outcome",
  async ({ lane: blockedLane, outcome }) => {
    const entered = createDeferred();
    const prepared = createDeferred();
    const refreshed = createDeferred();
    mocks.refresh.mockImplementation(async () => {
      refreshed.resolve();
      return null;
    });
    mocks.prewarm.mockImplementation(async (_database, lane = historyLane) => {
      if (lane === blockedLane) {
        entered.resolve();
        await prepared.promise;
      }
    });
    const controller = new AbortController();
    const activate = mocks.activate;
    const refresh = mocks.refresh;
    const registry = createEmptyPluginRegistry();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const observers = runGatewayStartupObservers({
      registry,
      resolveGatewayContext: () => undefined,
      loadSubagentRegistryActivation: async () =>
        (await import("../agents/subagents/registry/subagent-registry.js"))
          .activateSubagentRegistry,
      createHookRunner: async (...args) =>
        (await import("../plugins/hooks.js")).createHookRunner(...args),
      refreshLatestUpdateRestartSentinel: async () =>
        (await import("./server-update-sentinel.js")).prepareLatestUpdateRestartSentinel({}),
      signal: controller.signal,
      port: 0,
      config: {},
      workspaceDir: "/unused",
      getCron: () => undefined,
      isClosing: () => controller.signal.aborted,
      log,
      logHooks: log,
    });
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        observers,
        "restored recovery settled before preparing its transcript reader",
      );
      await awaitGateBeforeSettlement(
        refreshed.promise,
        observers,
        "startup observers settled before refreshing the restart sentinel",
      );
      expect(activate).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledOnce();
      if (outcome === "close") {
        controller.abort();
      }
      prepared.resolve();
      await observers;
      expect(activate).toHaveBeenCalledTimes(outcome === "activate" ? 1 : 0);
      if (outcome === "close" && blockedLane === historyLane) {
        expect(mocks.prewarm).toHaveBeenCalledOnce();
      }
    } finally {
      prepared.resolve();
      await observers;
    }
  },
);
