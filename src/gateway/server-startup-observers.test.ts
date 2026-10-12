import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  historyLane,
  maintenanceLane,
  type SessionHistoryWorkerLane,
} from "../config/sessions/session-transcript-worker-resources.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { runGatewayStartupObservers } from "./server-startup-observers.js";

const mocks = vi.hoisted(() => ({
  prewarm: vi.fn<(database: unknown, lane?: SessionHistoryWorkerLane) => Promise<void>>(),
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
    mocks.prewarm.mockImplementation(async (_database, lane = historyLane) => {
      if (lane === blockedLane) {
        entered.resolve();
        await prepared.promise;
      }
    });
    const controller = new AbortController();
    const activate = vi.fn();
    const registry = createEmptyPluginRegistry();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const observers = runGatewayStartupObservers({
      registry,
      resolveGatewayContext: () => undefined,
      loadSubagentRegistryActivation: () => activate,
      signal: controller.signal,
      port: 0,
      config: {},
      workspaceDir: "/unused",
      getCron: () => undefined,
      isClosing: () => controller.signal.aborted,
      log,
      logHooks: log,
      createHookRunner,
      refreshLatestUpdateRestartSentinel: async () => undefined,
    });
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        observers,
        "restored recovery settled before preparing its transcript reader",
      );
      expect(activate).not.toHaveBeenCalled();
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
