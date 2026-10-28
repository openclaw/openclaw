import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayWork from "../process/gateway-work-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import {
  assertAgentDatabaseAdmitted,
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startCronMaintenance, stopCronMaintenance } from "./maintenance.js";

const mocks = vi.hoisted(() => ({
  history: vi.fn(async (): Promise<{ nextSweepAtMs: number | null }> => ({ nextSweepAtMs: null })),
  historyChanged: undefined as ((databasePath: string) => void) | undefined,
  registry: vi.fn(
    async (): Promise<{
      nextSweepAtMs: number | null;
      pruned?: number;
      skippedStores?: number;
      skippedReason?: string;
    }> => ({ nextSweepAtMs: null, pruned: 0, skippedStores: 0 }),
  ),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// mock-isolation: Exercise the real startup and scheduler lifetimes without SQLite workers.
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({ admission: { assertCurrent() {} } }),
}));
// mock-isolation: Observe retention writes without starting database workers.
vi.mock("./store/run-history.js", () => ({ maintainCronRunHistory: mocks.history }));
// mock-isolation: Deliver a committed owner notification during an awaited history read.
vi.mock("./store/run-history-changes.js", () => ({
  subscribeCronRunHistoryChanges: (listener: (databasePath: string) => void) => {
    mocks.historyChanged = listener;
    return () => {
      mocks.historyChanged = undefined;
    };
  },
}));
// mock-isolation: Match synthetic receipt paths without resolving the user's state directory.
vi.mock("../state/openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqlitePath: () => "/synthetic/state.sqlite",
}));
// mock-isolation: Observe the session sweep without opening session stores.
vi.mock("./session-registry-maintenance.js", () => ({
  runSessionRegistryMaintenance: mocks.registry,
}));
// mock-isolation: Collect scheduler diagnostics without process-global log sinks.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ ...mocks, debug() {}, trace() {} }),
}));

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
const start = (getPath = () => "/synthetic/cron/jobs.json") =>
  startCronMaintenance(scheduler, getPath);
const pendingDatabase = () =>
  createAgentDatabaseInspectionRefusal({
    agentId: "main",
    paths: [],
    reason: "Startup preparation is pending",
    pending: true,
  });
const completed = (lastSuccessAtMs: number) => ({
  lastSuccessAtMs,
  nextSweepAtMs: null,
  pruned: 0,
  skippedStores: 0,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.history.mockReset().mockResolvedValue({ nextSweepAtMs: null });
  mocks.registry
    .mockReset()
    .mockResolvedValue({ nextSweepAtMs: null, pruned: 0, skippedStores: 0 });
  clock = createGatewaySchedulerClock();
  gatewayWork.resetGatewayWorkAdmission();
  recordAgentDatabaseAdmissions([]);
  scheduler = createTestGatewayScheduler(clock.clock);
});
afterEach(async () => {
  await stopCronMaintenance();
  await scheduler.stop();
  vi.restoreAllMocks();
  gatewayWork.resetGatewayWorkAdmission();
  recordAgentDatabaseAdmissions([]);
});

it("keeps pending database admission private when its publisher wakes retention", async () => {
  const ownerContext = new AsyncLocalStorage<string>();
  ownerContext.run("gateway", () => start());
  const pending = pendingDatabase();
  recordAgentDatabaseAdmissions([pending]);
  mocks.registry.mockImplementation(async () => {
    expect(ownerContext.getStore()).toBe("gateway");
    assertAgentDatabaseAdmitted("healthy");
    return {
      nextSweepAtMs: null,
      skippedStores: readAgentDatabaseAdmissionRefusal("main") ? 1 : 0,
    };
  });
  await preparePendingAgentDatabase(pending, { assertCurrent() {} }, async () => {
    sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
    await clock.advanceBy(0);
    expect(mocks.info).toHaveBeenLastCalledWith(
      "Session registry maintenance completed",
      expect.objectContaining({ skippedStores: 1 }),
    );
  });
  await clock.advanceBy(0);
  expect(mocks.info).toHaveBeenLastCalledWith(
    "Session registry maintenance completed",
    expect.objectContaining({ skippedStores: 0 }),
  );
  expect(mocks.warn).not.toHaveBeenCalled();
});

it("finishes retention and rearms after a notifying preparation ends during a read", async () => {
  const readEntered = createDeferredCore();
  const readReply = createDeferredCore();
  const pending = pendingDatabase();
  start();
  recordAgentDatabaseAdmissions([pending]);
  mocks.registry
    .mockImplementation(async () => {
      assertAgentDatabaseAdmitted("main");
      return { nextSweepAtMs: null };
    })
    .mockImplementationOnce(async () => {
      readEntered.resolve();
      await readReply.promise;
      assertAgentDatabaseAdmitted("main");
      return { nextSweepAtMs: 60_000 };
    });
  let tick = Promise.resolve();
  try {
    await preparePendingAgentDatabase(pending, { assertCurrent() {} }, async () => {
      sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
      tick = Promise.resolve(clock.advanceBy(0));
      await readEntered.promise;
    });
    readReply.resolve();
    await tick;
    await clock.advanceTo(60_000);
    expect(mocks.registry).toHaveBeenCalledTimes(2);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledTimes(2);
    expect(scheduler.nextWakeAtMs).toBeNull();
  } finally {
    readReply.resolve();
    await tick;
  }
});

it.each([
  { pending: false, notification: "none" },
  { pending: true, notification: "none" },
  { pending: true, notification: "agent" },
  { pending: true, notification: "history" },
])(
  "runs healthy retention independently, pending=$pending, notification=$notification",
  async ({ pending, notification }) => {
    await withAgentDatabaseStartupAdmission(async (admission) => {
      const preparation = createDeferredCore();
      start();
      // Preparation discovered after scheduling must not hold healthy retention either.
      if (pending) {
        admission.track(preparation.promise);
      }
      runInDetachedAsyncContext(() => {
        if (notification === "agent") {
          sessionChanges.emit({ all: true, scope: { agentId: "ready-agent", topology: true } });
        } else if (notification === "history") {
          mocks.historyChanged?.("/synthetic/state.sqlite");
        }
      });
      const tick = clock.advanceBy(5_000);
      try {
        expect(mocks.history).toHaveBeenCalledOnce();
        await tick;
        expect(mocks.history).toHaveBeenCalledOnce();
        expect(mocks.registry).toHaveBeenCalledOnce();
        expect(mocks.warn).not.toHaveBeenCalled();
        expect(mocks.error).not.toHaveBeenCalled();
        expect(scheduler.nextWakeAtMs).toBeNull();
        await clock.advanceBy(60_000);
        expect(mocks.history).toHaveBeenCalledOnce();
        expect(mocks.registry).toHaveBeenCalledOnce();
        expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
          "Session registry maintenance completed",
          completed(5_000),
        );
      } finally {
        preparation.resolve();
        await tick;
      }
    });
  },
);

it("sleeps until the retained session deadline when history is empty", async () => {
  mocks.registry.mockResolvedValueOnce({ nextSweepAtMs: 70_000 });
  let cronStorePath = "/synthetic/cron/first.json";
  start(() => cronStorePath);
  await clock.advanceBy(5_000);
  await clock.advanceTo(65_000);
  expect(mocks.history).toHaveBeenCalledOnce();
  expect(mocks.registry).toHaveBeenCalledOnce();
  expect(mocks.registry).toHaveBeenLastCalledWith(expect.objectContaining({ cronStorePath }));
  cronStorePath = "/synthetic/cron/reloaded.json";
  await clock.advanceTo(70_000);
  expect(mocks.registry).toHaveBeenLastCalledWith(expect.objectContaining({ cronStorePath }));
  expect(mocks.history).toHaveBeenCalledOnce();
  expect(mocks.registry).toHaveBeenCalledTimes(2);
});

it.each(["session", "stores", "config", "agent-ready"] as const)(
  "wakes for committed %s changes and replaces their previous expiry without polling unrelated sessions",
  async (kind) => {
    mocks.registry.mockResolvedValueOnce({ nextSweepAtMs: 200_000 });
    start();
    await clock.advanceBy(5_000);
    await clock.advanceTo(10_000);
    sessionChanges.emit({ sessionKey: "agent:main:main", scope: "session-entry" });
    await clock.advanceTo(65_000);
    expect(mocks.registry).toHaveBeenCalledOnce();

    mocks.registry.mockResolvedValueOnce({ nextSweepAtMs: 500_000 });
    if (kind === "session") {
      sessionChanges.emit({ sessionKey: "agent:main:cron:job:run:new", scope: "session-entry" });
    } else if (kind === "agent-ready") {
      sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
    } else {
      sessionChanges.emit({ all: true, scope: kind });
    }
    await clock.advanceTo(kind === "agent-ready" ? 65_000 : 125_000);
    expect(mocks.registry).toHaveBeenCalledTimes(2);
    await clock.advanceTo(200_000);
    expect(mocks.registry).toHaveBeenCalledTimes(2);
  },
);

it.each(["registry", "history"] as const)(
  "retains a %s invalidation received during its read",
  async (owner) => {
    const entered = createDeferredCore();
    const result = createDeferredCore<{ nextSweepAtMs: number | null }>();
    mocks[owner].mockImplementationOnce(() => {
      entered.resolve();
      return result.promise;
    });
    start();
    const sweep = clock.advanceBy(5_000);
    await entered.promise;
    if (owner === "registry") {
      sessionChanges.emit({ sessionKey: "agent:main:cron:job:run:new", scope: "session-entry" });
    } else {
      mocks.historyChanged?.("/synthetic/state.sqlite");
    }
    result.resolve({ nextSweepAtMs: 500_000 });
    await sweep;
    await clock.advanceTo(65_000);
    expect(mocks[owner]).toHaveBeenCalledTimes(2);
    if (owner === "history") {
      await clock.advanceTo(500_000);
      expect(mocks.history).toHaveBeenCalledTimes(2);
      await stopCronMaintenance();
      start();
      await clock.advanceBy(5_000);
      expect(mocks.history).toHaveBeenCalledTimes(3);
    }
  },
);

it("keeps the last completed sweep visible when missing cron facts defer the next pass", async () => {
  start();
  await clock.advanceBy(5_000);
  mocks.registry.mockResolvedValueOnce({
    nextSweepAtMs: 125_000,
    skippedReason: "synthetic unreadable cron store",
  });
  sessionChanges.emit({ sessionKey: "agent:main:cron:job:run:new", scope: "session-entry" });
  await clock.advanceTo(65_000);
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("Session registry maintenance skipped", {
    reason: "synthetic unreadable cron store",
    retryAtMs: 125_000,
    lastSuccessAtMs: 5_000,
  });
  expect(mocks.info).toHaveBeenCalledOnce();
  await clock.advanceTo(125_000);
  expect(mocks.info).toHaveBeenLastCalledWith(
    "Session registry maintenance completed",
    completed(125_000),
  );
});

it("does not mistake an unknown failure with the snapshot error text for an expected deferral", async () => {
  const failure = new Error("Agent database deletion snapshot changed during consumption.");
  mocks.registry.mockRejectedValueOnce(failure);
  start();
  await clock.advanceBy(5_000);
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("Cron maintenance failed", { error: failure });
  expect(mocks.info).not.toHaveBeenCalled();
  expect(scheduler.nextWakeAtMs).toBe(65_000);
  await clock.advanceTo(65_000);
  expect(mocks.registry).toHaveBeenCalledTimes(2);
  expect(mocks.info).toHaveBeenCalledOnce();
});

describe("Cron maintenance admission diagnostics", () => {
  it("joins scheduler shutdown while maintenance is still waiting behind suspension", async () => {
    const suspension = gatewayWork.tryBeginGatewaySuspendAdmission(() => {});
    if (!suspension?.commit()) {
      throw new Error("Expected to suspend task admission");
    }
    try {
      start();
      const tick = clock.advanceBy(5_000);
      await scheduler.stop();
      await tick;
      expect(mocks.history).not.toHaveBeenCalled();
      expect(mocks.warn).not.toHaveBeenCalled();
      expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      await stopCronMaintenance();
      suspension.release();
    }
  });

  it.each([false, true])(
    "does not report a refused sweep when restart begins after suspension=%s",
    async (suspended) => {
      const suspension = suspended ? gatewayWork.tryBeginGatewaySuspendAdmission(() => {}) : null;
      if (suspended && (!suspension || !suspension.commit())) {
        throw new Error("Expected to suspend task admission");
      }
      try {
        start();
        const pending = suspended ? clock.advanceBy(5_000) : undefined;
        gatewayWork.markGatewayRestartDraining();
        await pending;
        await clock.advanceBy(60_000);
        expect(mocks.history).not.toHaveBeenCalled();
        expect(mocks.warn).not.toHaveBeenCalled();
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        await stopCronMaintenance();
        suspension?.release();
      }
    },
  );

  it("reports an unexpected admission failure even during restart drain", async () => {
    const failure = new Error("synthetic admission failure");
    vi.spyOn(gatewayWork, "runWithGatewayIndependentRootWorkAdmission").mockRejectedValueOnce(
      failure,
    );

    gatewayWork.markGatewayRestartDraining();
    start();
    await clock.advanceBy(5_000);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("Cron maintenance failed", {
      error: failure,
    });
  });

  it.each([{ kind: "drain", failure: new gatewayWork.GatewayDrainingError() }])(
    "reports an admitted $kind failure while stop joins its sweep",
    async ({ failure }) => {
      const sweep = createDeferredCore<{ nextSweepAtMs: number | null }>();
      mocks.history.mockImplementation(() => sweep.promise);

      try {
        start();
        const tick = clock.advanceBy(5_000);
        expect(mocks.history).toHaveBeenCalledOnce();
        gatewayWork.markGatewayRestartDraining();
        const gatewayStopping = scheduler.stop();
        let stopped = false;
        const stopping = stopCronMaintenance().then(() => {
          stopped = true;
        });
        expect(stopped).toBe(false);
        sweep.reject(failure);
        await stopping;
        await gatewayStopping;
        await tick;
        expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("Cron maintenance failed", {
          error: failure,
        });
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        sweep.resolve({ nextSweepAtMs: null });
        await stopCronMaintenance();
      }
    },
  );
});

it("runs overdue history retention after sleep and leaves unrelated writes parked", async () => {
  mocks.history.mockResolvedValueOnce({ nextSweepAtMs: 300_000 });
  start();
  await clock.advanceBy(5_000);
  mocks.historyChanged?.("/unrelated/state.sqlite");
  await clock.advanceTo(299_999);
  expect(mocks.history).toHaveBeenCalledOnce();
  await clock.advanceTo(360_000);
  expect(mocks.history).toHaveBeenCalledTimes(2);
});
