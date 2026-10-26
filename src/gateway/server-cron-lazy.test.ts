import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import type { CliDeps } from "../cli/deps.types.js";
import { createMockCronStateForJobs } from "../cron/service.test-harness.js";
import { listPage } from "../cron/service/ops-read.js";
import type { CronJob } from "../cron/types.js";
import {
  createSqliteReadOnlyWorkerScope,
  isSqliteInspectionDeadlineOwnedByCaller,
} from "../infra/sqlite-readonly-worker.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayCronServiceContract, GatewayCronState } from "./server-cron-contract.js";

const { buildGatewayCronService } = vi.hoisted(() => ({ buildGatewayCronService: vi.fn() }));
// mock-isolation: Keep the heavy cron runtime unloaded to prove lazy service creation.
vi.mock("./server-cron.js", () => ({ buildGatewayCronService }));

const { createLazyGatewayCronState } = await import("./server-cron-lazy.js");

describe("createLazyGatewayCronState", () => {
  const createBroker = useSpawnBrokerTestFixture(afterEach);
  let cron: ReturnType<typeof createCronService>;
  let state: GatewayCronState;
  let lazy: ReturnType<typeof createLazyGatewayCronState>;
  beforeEach(() => {
    vi.unstubAllEnvs();
    cron = createCronService();
    state = {
      cron,
      storePath: "/tmp/openclaw-cron.json",
      cronEnabled: true,
      reconcileExitWatchers: vi.fn(async () => {}),
      reconcileStreamWatchers: vi.fn(async () => {}),
      stopStreamWatchers: vi.fn(async () => {}),
    };
    buildGatewayCronService.mockReset().mockImplementation(() => state);
    lazy = createLazyGatewayCronState(createParams());
  });

  it("does not build the heavy cron service until an async cron operation needs it", async () => {
    const broker = await createBroker();
    let observedBroker: unknown = "not-built";
    let observedReadOnlyScope = false;
    buildGatewayCronService.mockImplementationOnce(() => {
      observedBroker = getSpawnBroker();
      observedReadOnlyScope = isSqliteInspectionDeadlineOwnedByCaller();
      return state;
    });
    const readers = createSqliteReadOnlyWorkerScope({
      signal: new AbortController().signal,
      deadlineOwnedByCaller: true,
    });
    lazy = readers.run(() =>
      runWithSpawnBroker(broker, () => createLazyGatewayCronState(createParams())),
    );
    state.readHeartbeatSummary = vi.fn(async () => []);
    expect(lazy.readHeartbeatSummary).toBeUndefined();
    await expect(lazy.prepareExitWatcherHandoff?.()).resolves.toBeUndefined();
    await lazy.stopStreamWatchers();
    expect(buildGatewayCronService).not.toHaveBeenCalled();
    expect(lazy.cron.getJob("demo")).toBeUndefined();
    expect(lazy.cron.getDefaultAgentId()).toBeUndefined();
    try {
      await runInDetachedAsyncContext(() => lazy.cron.status());
    } finally {
      await readers.close();
    }
    expect(buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(lazy.readHeartbeatSummary).toBe(state.readHeartbeatSummary);
    expect(observedBroker === broker).toBe(true);
    expect(observedReadOnlyScope).toBe(true);
  });

  it("keeps visibility filtering inside the loaded service's page snapshot", async () => {
    const jobs: CronJob[] = ["hidden", "visible"].map((id) => ({
      id,
      name: id,
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    }));
    const store = createMockCronStateForJobs({ jobs });
    const start = vi.spyOn(cron, "start");
    cron.listPage.mockImplementation((opts, matchesJob) => listPage(store, opts, matchesJob));
    const page = await lazy.cron.listPage(
      { includeDisabled: true, limit: 1, sortBy: "name" },
      (job) => job.id === "visible",
    );
    expect(page).toMatchObject({ total: 1, hasMore: false, jobs: [jobs[1]] });
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves a watcher owner when hot reload overtakes lazy startup", async () => {
    const finishStart = deferred();
    cron.start = vi.fn(async () => await finishStart.promise);
    const watchers = {
      reconcile: vi.fn(),
      cancel: vi.fn(),
      cancelAll: vi.fn(async () => {}),
      activeJobIds: vi.fn(() => ["watched-job"]),
      updateHandlers: vi.fn(),
    };
    const stopOwner = vi.fn(async () => {});
    const prepareExitWatcherHandoff = vi.fn(async () => ({
      current: () => watchers,
      adopt: vi.fn(),
      stopOwner,
    }));
    state.prepareExitWatcherHandoff = prepareExitWatcherHandoff;
    const start = lazy.cron.start();
    await vi.waitFor(() => expect(cron.start).toHaveBeenCalledOnce());
    const handoff = await lazy.prepareExitWatcherHandoff?.();
    expect(handoff?.current()).toBe(watchers);
    await handoff?.stopOwner();
    finishStart.resolve();
    await start;
    await handoff?.stopOwner();
    expect(prepareExitWatcherHandoff).toHaveBeenCalledOnce();
    expect(stopOwner).toHaveBeenCalledOnce();
    expect(watchers.cancelAll).not.toHaveBeenCalled();
    expect(cron.stop).not.toHaveBeenCalled();
  });

  it("forwards update authority options through lazy cron loading", async () => {
    const opts = {
      commitGuard: vi.fn(),
      captureRuntimeAuthority: vi.fn(() => undefined),
    };
    const precondition = vi.fn();
    await lazy.cron.update("demo", { description: "updated" }, opts);
    await lazy.cron.updateWithPrecondition(
      "demo",
      { description: "updated again" },
      precondition,
      opts,
    );
    expect(cron.update).toHaveBeenCalledExactlyOnceWith("demo", { description: "updated" }, opts);
    expect(cron.updateWithPrecondition).toHaveBeenCalledExactlyOnceWith(
      "demo",
      { description: "updated again" },
      precondition,
      opts,
    );
  });

  it("preserves system-owned removal authority across lazy cron loading", async () => {
    await lazy.cron.remove("heartbeat-monitor", { systemOwned: true });
    expect(cron.remove).toHaveBeenCalledExactlyOnceWith("heartbeat-monitor", {
      systemOwned: true,
    });
  });

  it("prepares a lazy scheduler before an operator wake without starting it", async () => {
    await lazy.cron.prepareWake?.();
    expect(await lazy.cron.wake({ mode: "now", text: "ping" })).toEqual({ ok: true });
    expect(cron.start).not.toHaveBeenCalled();
    expect(cron.wake).toHaveBeenCalledExactlyOnceWith({ mode: "now", text: "ping" });
  });

  it("rejects a deferred notice when the lazy scheduler stops during admission", async () => {
    const entered = deferred();
    const resume = deferred();
    let committed = false;
    state.deferHookWake = async ({ commitGuard }) => {
      entered.resolve();
      await resume.promise;
      commitGuard();
      committed = true;
      return { ok: true, eventOutcome: "queued" };
    };
    const request = lazy.deferHookWake!({
      text: "Scheduled notice",
      agentId: "main",
      commitGuard() {},
    });
    const refused = expect(request).rejects.toThrow("Scheduled Hook wake owner changed");
    await entered.promise;
    lazy.cron.stop();
    resume.resolve();
    await refused;
    expect(committed).toBe(false);
  });

  it.each(["run", "enqueueRun"] as const)(
    "finishes startup recovery before admitting a manual %s",
    async (operation) => {
      const recoveryStarted = deferred();
      const recoveryFinished = deferred();
      const start = vi.fn(async () => {
        recoveryStarted.resolve();
        await recoveryFinished.promise;
      });
      cron.start = start;

      const run = lazy.cron[operation]("demo", "force");
      await Promise.race([
        recoveryStarted.promise,
        run.then(() => {
          throw new Error("Manual cron run was admitted before startup recovery");
        }),
      ]);
      expect(cron[operation]).not.toHaveBeenCalled();
      recoveryFinished.resolve();
      await run;

      expect(cron[operation]).toHaveBeenCalledExactlyOnceWith("demo", "force");
    },
  );

  it.each(["run", "enqueueRun"] as const)(
    "keeps a stopped scheduler stopped when a manual %s arrives",
    async (operation) => {
      await lazy.cron.status();
      lazy.cron.stop();

      await lazy.cron[operation]("demo", "force");

      expect(cron.start).not.toHaveBeenCalled();
      expect(cron.stop).toHaveBeenCalledOnce();
      expect(cron[operation]).toHaveBeenCalledExactlyOnceWith("demo", "force");
    },
  );

  it("does not start cron after stop wins the lazy startup race", async () => {
    const startPromise = lazy.cron.start();
    lazy.cron.stop();
    await startPromise;
    expect(cron.start).not.toHaveBeenCalled();
    expect(cron.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps wake non-blocking before the cron service is loaded", async () => {
    expect(await lazy.cron.wake({ mode: "now", text: "ping" })).toEqual({ ok: false });
    await vi.waitFor(() => {
      expect(buildGatewayCronService).toHaveBeenCalledTimes(1);
    });
    expect(cron.wake).not.toHaveBeenCalled();
  });

  it("forwards scheduling intent without loading the cron owner", async () => {
    lazy.cron.pauseScheduling();
    expect(buildGatewayCronService).not.toHaveBeenCalled();
    lazy.cron.resumeScheduling();
    expect(buildGatewayCronService).not.toHaveBeenCalled();
    lazy.cron.pauseScheduling();
    await lazy.cron.status();
    expect(cron.pauseScheduling).toHaveBeenCalledOnce();
    lazy.cron.resumeScheduling();
    expect(cron.resumeScheduling).toHaveBeenCalledOnce();
    lazy.cron.pauseScheduling();
    lazy.cron.resumeScheduling();
    expect(cron.resumeScheduling).toHaveBeenCalledTimes(2);
  });

  it("allows startup to retry after the underlying service rejects", async () => {
    cron.start = vi
      .fn()
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(undefined);
    await expect(lazy.cron.start()).rejects.toThrow("startup failed");
    await lazy.cron.start();
    expect(cron.start).toHaveBeenCalledTimes(2);
  });

  it("forwards watcher reconciliation and teardown hooks through the proxy", async () => {
    await lazy.reconcileExitWatchers();
    await lazy.reconcileStreamWatchers();
    expect(state.reconcileExitWatchers).toHaveBeenCalledTimes(1);
    expect(state.reconcileStreamWatchers).toHaveBeenCalledTimes(1);
    await lazy.stopStreamWatchers();
    expect(state.stopStreamWatchers).toHaveBeenCalledTimes(1);
  });
});

function createParams() {
  return {
    storePath: "/tmp/openclaw-cron.json",
    scheduler: createTestGatewayScheduler(),
    cfg: {},
    deps: {} as CliDeps,
    broadcast: vi.fn(),
  };
}

function createCronService() {
  return {
    start: vi.fn<GatewayCronServiceContract["start"]>(async () => {}),
    stop: vi.fn(),
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    status: vi.fn(async () => ({ enabled: true }) as never),
    list: vi.fn(async () => [] as never),
    listPage: vi.fn<GatewayCronServiceContract["listPage"]>(),
    add: vi.fn(async () => ({ ok: true }) as never),
    update: vi.fn(async () => ({ ok: true }) as never),
    updateWithPrecondition: vi.fn(async () => ({ ok: true }) as never),
    remove: vi.fn(async () => ({ ok: true }) as never),
    removeStaleJobFamily: vi.fn(async () => 0),
    removeAgentJobsTransactional: vi.fn(async (_agentId, commit) => await commit()),
    quiesceJobs: vi.fn(async (_jobs, commitGuard) => {
      commitGuard();
    }),
    run: vi.fn(async () => ({ ok: true, ran: false, reason: "invalid-spec" }) as never),
    enqueueRun: vi.fn(async () => ({ ok: true, ran: false, reason: "invalid-spec" }) as never),
    readEventSources: vi.fn<GatewayCronServiceContract["readEventSources"]>(async () => []),
    runEvent: vi.fn<GatewayCronServiceContract["runEvent"]>(async () => ({ kind: "invalidated" })),
    waitForManualRun: vi.fn(async () => true),
    getJob: vi.fn(() => undefined),
    readJob: vi.fn(async () => undefined),
    readScratch: vi.fn(async () => ({ currentRevision: 0 })),
    writeScratch: vi.fn(async () => ({ ok: true, currentRevision: 1 }) as never),
    getDefaultAgentId: vi.fn(() => "default"),
    wake: vi.fn(async () => ({ ok: true })),
  } satisfies GatewayCronServiceContract;
}
