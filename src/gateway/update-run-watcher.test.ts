import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { UpdateCampaignController } from "../infra/update-campaign.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../infra/update-check-lifecycle.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { StateSchemaPublicationBlocker } from "../state/openclaw-state-schema-publication.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startUpdateRunWatcher, wakeUpdateRunWatcher } from "./update-run-watcher.js";

const ledger = vi.hoisted(() => ({
  run: undefined as UpdateRunRecord | undefined,
  reads: vi.fn<(kind: "run" | "status") => void>(),
  reconcile: vi.fn<(input: { signal?: AbortSignal }) => Promise<UpdateRunRecord[]>>(),
  notice: vi.fn(async (_run: UpdateRunRecord) => {}),
  sentinel: vi.fn<() => Promise<RestartSentinelPayload | null>>(),
  publication:
    vi.fn<
      (options: { signal?: AbortSignal }) => Promise<StateSchemaPublicationBlocker | undefined>
    >(),
}));
vi.mock("../state/openclaw-state-schema-publication.async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-schema-publication.async.js")>()),
  reconcileOpenClawStateSchemaPublicationAsync: ledger.publication,
}));
vi.mock("../infra/update-run-interruption.js", () => ({
  reconcileInterruptedUpdateRuns: ledger.reconcile,
}));
vi.mock("./update-run-notice.runtime.js", () => ({ notifyUpdateRunPhase: ledger.notice }));
vi.mock("./server-update-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-update-sentinel.js")>()),
  refreshLatestUpdateRestartSentinel: ledger.sentinel,
  getLatestUpdateRestartSentinel: () => null,
}));
vi.mock("../infra/update-run-ledger.js", () => ({
  reconcileAbandonedUpdateRunsAsync: async () => [],
  listUpdateRunsAsync: async () => {
    ledger.reads("status");
    return ledger.run?.status === "running" ? [ledger.run] : [];
  },
  getUpdateRunAsync: async () => {
    ledger.reads("run");
    return ledger.run;
  },
}));

let watcher: ReturnType<typeof startUpdateRunWatcher> | undefined;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let lifecycle: UpdateCheckLifecycle;
const broadcast = vi.fn();
const warn = vi.fn();
beforeEach(() => {
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
  lifecycle = createGatewayUpdateLifecycle(scheduler);
  ledger.run = undefined;
  ledger.reads.mockReset();
  ledger.reconcile.mockReset().mockResolvedValue([]);
  ledger.notice.mockReset().mockResolvedValue(undefined);
  ledger.sentinel.mockReset().mockResolvedValue(null);
  ledger.publication.mockReset().mockResolvedValue(undefined);
  broadcast.mockReset();
  warn.mockReset();
});
afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  await lifecycle.stop();
  await scheduler.stop();
  vi.restoreAllMocks();
});

function beginRun(runId = "b7150827-8222-4c12-bd20-9bfd6ae8e852"): UpdateRunRecord {
  ledger.run = {
    runId,
    createdAtMs: 1,
    trigger: "cli",
    reason: null,
    target: {},
    before: {},
    after: {},
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
    phase: "requested",
    status: "running",
    updatedAtMs: 1,
    steps: [],
    origin: {},
  };
  return ledger.run;
}

function currentRunEvent() {
  const { runId, phase, status, updatedAtMs } = ledger.run!;
  return { runId, phase, status, updatedAtMs };
}

function startWatcher() {
  return startUpdateRunWatcher({ lifecycle, broadcast, log: { warn } });
}

function nextBroadcast(onBroadcast?: () => void) {
  const observed = createDeferredCore();
  broadcast.mockImplementationOnce(() => {
    onBroadcast?.();
    observed.resolve();
  });
  return observed.promise;
}

function nextLedgerRead(kind?: "run" | "status") {
  const entered = createDeferredCore();
  ledger.reads.mockImplementation((observed) => {
    if (kind === undefined || observed === kind) {
      ledger.reads.mockImplementation(() => {});
      entered.resolve();
    }
  });
  return entered.promise;
}

function nextPollSchedule() {
  const scheduled = createDeferredCore();
  const arm = clock.clock.arm;
  const observer = vi.spyOn(clock.clock, "arm").mockImplementation((run, delayMs) => {
    const cancel = arm(run, delayMs);
    if (delayMs === 2_000) {
      observer.mockRestore();
      scheduled.resolve();
    }
    return cancel;
  });
  return scheduled.promise;
}

describe("Gateway update run watcher", () => {
  it("joins in-flight schema publication on shutdown without arming its returned deadline", async () => {
    const publication = createDeferredCore<StateSchemaPublicationBlocker>();
    const entered = createDeferredCore();
    let publicationSignal: AbortSignal | undefined;
    const events: string[] = [];
    ledger.publication.mockImplementationOnce(async ({ signal }) => {
      publicationSignal = signal;
      entered.resolve();
      const blocker = await publication.promise;
      events.push("publication-settled");
      return blocker;
    });
    watcher = startWatcher();
    await entered.promise;
    const stopping = watcher.stop().then(() => events.push("stopped"));
    try {
      expect(publicationSignal?.aborted).toBe(true);
      expect(events).toEqual([]);
    } finally {
      publication.resolve({ runId: "legacy-run", updaterVersion: "2026.9.2", publishAfterMs: 100 });
      await stopping;
    }
    expect(events).toEqual(["publication-settled", "stopped"]);
    expect(ledger.reads).not.toHaveBeenCalled();
    expect(clock.armedAtMs).toBeNull();
    await clock.advanceBy(100);
    expect(ledger.publication).toHaveBeenCalledOnce();
  });

  it("clears a campaign created after watcher startup before publishing its terminal run", async () => {
    beginRun();
    const onChange = vi.fn();
    const campaign = new UpdateCampaignController(scheduler);
    const initial = nextBroadcast();
    const terminal = nextBroadcast(() => expect(campaign.getState()).toBeUndefined());
    watcher = startWatcher();
    lifecycle.campaign = campaign;
    campaign.announce({
      target: { kind: "package", version: "2026.9.6" },
      apply: async () => "applied",
      onChange,
    });
    campaign.adopt();
    ledger.run!.origin = { campaignId: campaign.getState()!.id };
    await initial;
    ledger.run = { ...ledger.run!, status: "failed", phase: "finished", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    await terminal;
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    expect(ledger.notice).not.toHaveBeenCalled();
  });

  it("joins an entered notice during shutdown and retires queued notices", async () => {
    beginRun();
    const notice = createDeferredCore();
    const noticeStarted = createDeferredCore();
    const events: string[] = [];
    ledger.notice.mockImplementationOnce(async () => {
      events.push("notice-started");
      noticeStarted.resolve();
      await notice.promise;
      events.push("notice-completed");
    });
    watcher = startWatcher();
    ledger.run = { ...ledger.run!, phase: "activating", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    await noticeStarted.promise;
    ledger.run = {
      ...ledger.run!,
      phase: "finished",
      status: "succeeded",
      updatedAtMs: 3,
      steps: [{ step: "notice:ack", status: "completed" }],
    };
    await clock.advanceBy(2_000);
    const stopping = Promise.resolve(watcher.stop()).then(() => events.push("stopped"));
    try {
      await clock.advanceBy(0);
      expect(events).toEqual(["notice-started"]);
      notice.resolve();
      await stopping;
      expect(events).toEqual(["notice-started", "notice-completed", "stopped"]);
      expect(ledger.notice).toHaveBeenCalledOnce();
    } finally {
      notice.resolve();
      await stopping;
    }
  });

  it("keeps phase notices and terminal scans responsive while candidate verification is pending", async () => {
    beginRun();
    ledger.run!.steps = [{ step: "notice:ack", status: "completed" }];
    const verification = createDeferredCore<UpdateRunRecord[]>();
    const activatingNotice = createDeferredCore();
    const finishedNotice = createDeferredCore();
    ledger.reconcile.mockReturnValueOnce(verification.promise);
    ledger.notice
      .mockImplementationOnce(async () => activatingNotice.resolve())
      .mockImplementationOnce(async () => finishedNotice.resolve());
    watcher = startWatcher();
    try {
      ledger.run = { ...ledger.run!, phase: "activating", updatedAtMs: 2 };
      await clock.advanceBy(2_000);
      await activatingNotice.promise;
      expect(ledger.notice).toHaveBeenCalledOnce();
      ledger.run = { ...ledger.run!, updatedAtMs: 3 };
      const unchangedPhase = nextPollSchedule();
      await clock.advanceBy(4_000);
      await unchangedPhase;
      expect(ledger.notice).toHaveBeenCalledOnce();
      ledger.run = { ...ledger.run!, phase: "finished", status: "succeeded", updatedAtMs: 4 };
      await clock.advanceBy(2_000);
      await finishedNotice.promise;
      expect(ledger.notice.mock.calls.map(([run]) => run.phase)).toEqual([
        "activating",
        "finished",
      ]);
      expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
      expect(ledger.reconcile).toHaveBeenCalledOnce();
    } finally {
      verification.resolve([]);
    }
  });

  it("publishes a newer correction returned by held verification", async () => {
    const first = beginRun();
    first.phase = "verifying";
    first.steps = [{ step: "notice:ack", status: "completed" }];
    const initialBroadcast = nextBroadcast();
    const verificationStarted = createDeferredCore();
    const verification = createDeferredCore<UpdateRunRecord[]>();
    const nextCycle = createDeferredCore();
    const firstNotice = createDeferredCore();
    const correctionNotice = createDeferredCore();
    ledger.reconcile
      .mockImplementationOnce(async () => {
        verificationStarted.resolve();
        return await verification.promise;
      })
      .mockImplementationOnce(async () => {
        nextCycle.resolve();
        return [];
      });
    ledger.notice.mockImplementation(async (run) => {
      if (run.runId !== first.runId) {
        return;
      }
      if (run.updatedAtMs === 2) {
        firstNotice.resolve();
      } else {
        correctionNotice.resolve();
      }
    });
    watcher = startWatcher();
    try {
      await initialBroadcast;
      await verificationStarted.promise;
      const terminal: UpdateRunRecord = {
        ...first,
        phase: "finished",
        status: "failed",
        reason: "abandoned",
        updatedAtMs: 2,
        finishedAtMs: 2,
      };
      // The row is committed, but this verification cycle still holds its reply.
      ledger.run = terminal;
      await clock.advanceBy(2_000);
      await firstNotice.promise;

      const settled: UpdateRunRecord = {
        ...terminal,
        status: "succeeded",
        reason: null,
        updatedAtMs: 3,
        finishedAtMs: 3,
      };
      ledger.run = settled;
      verification.resolve([settled]);
      await correctionNotice.promise;
      // A follow-up cycle starts only after the held result's scan has completed.
      await nextCycle.promise;
      await watcher.stop();
      expect(
        broadcast.mock.calls
          .filter(([, run]) => run.runId === first.runId && run.status !== "running")
          .map(([, run]) => run.updatedAtMs),
      ).toEqual([2, 3]);
      expect(
        ledger.notice.mock.calls
          .filter(([run]) => run.runId === first.runId)
          .map(([run]) => run.updatedAtMs),
      ).toEqual([2, 3]);
    } finally {
      verification.resolve([]);
      await watcher.stop();
    }
  });

  it("wakes for admission, observes a terminal repair after a long pause, and stops polling", async () => {
    const initialRead = nextLedgerRead("status");
    const requested = nextBroadcast();
    const staging = nextBroadcast();
    const terminal = nextBroadcast();
    watcher = startWatcher();
    await clock.advanceBy(10_000);
    await initialRead;
    expect(ledger.reads).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();

    beginRun();
    wakeUpdateRunWatcher();
    await requested;
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    const unchanged = nextPollSchedule();
    await clock.advanceBy(2_000);
    await unchanged;
    expect(broadcast).toHaveBeenCalledOnce();
    ledger.run = { ...ledger.run!, phase: "staging", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    await staging;
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    await nextPollSchedule();
    const beforeSleep = ledger.reads.mock.calls.length;
    const entered = nextLedgerRead("run");
    const rearmed = nextPollSchedule();
    const catchUp = clock.advanceBy(46 * 60_000);
    await entered;
    expect(ledger.reads).toHaveBeenCalledTimes(beforeSleep + 1);
    await catchUp;
    await rearmed;
    const delivered = createDeferredCore();
    ledger.notice.mockImplementationOnce(async () => delivered.resolve());
    const idle = nextLedgerRead("status");
    ledger.run = {
      ...ledger.run!,
      phase: "finished",
      status: "failed",
      updatedAtMs: 3,
      steps: [{ step: "notice:ack", status: "completed" }],
    };
    await clock.advanceBy(2_000);
    await terminal;
    await delivered.promise;
    await idle;
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    expect(ledger.notice).toHaveBeenCalledExactlyOnceWith(ledger.run);
    const reads = ledger.reads.mock.calls.length;
    await clock.advanceBy(60_000);
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it.each(["unavailable", "timed-out", "superseded"] as const)(
    "owns late terminal sentinel observation until %s",
    async (outcome) => {
      const run = beginRun();
      const pending: RestartSentinelPayload = {
        kind: "update",
        status: "skipped",
        ts: 1,
        stats: { runId: run.runId, reason: "managed-service-handoff-started" },
      };
      ledger.sentinel.mockResolvedValue(pending);
      const initial = nextBroadcast();
      const terminal = nextBroadcast();
      const idle = createDeferredCore();
      const settled = nextBroadcast(() => {
        if (outcome !== "superseded") {
          void nextLedgerRead("status").then(() => idle.resolve());
        }
      });
      watcher = startWatcher();
      await initial;
      ledger.run = { ...run, status: "failed", phase: "finished", updatedAtMs: 2 };
      if (outcome === "unavailable") {
        ledger.sentinel.mockRejectedValueOnce(new Error("state unavailable"));
      }
      await clock.advanceBy(2_000);
      await terminal;
      expect(scheduler.nextWakeAtMs).not.toBeNull();
      if (outcome === "superseded") {
        beginRun("aa688074-cb7a-4fb8-ae6a-e099e37e1d20");
        ledger.sentinel.mockResolvedValue(null);
        await clock.advanceBy(2_000);
        await settled;
        expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
        return;
      }
      if (outcome !== "timed-out") {
        ledger.sentinel.mockResolvedValue({
          ...pending,
          status: "error",
          stats: { runId: run.runId },
        });
      }
      await clock.advanceBy(outcome === "timed-out" ? 30 * 60_000 : 2_000);
      await settled;
      await idle.promise;
      expect(ledger.sentinel).toHaveBeenCalled();
      expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
      const reads = ledger.reads.mock.calls.length;
      await clock.advanceBy(60_000);
      expect(ledger.reads).toHaveBeenCalledTimes(reads);
      if (outcome === "timed-out") {
        expect(warn).toHaveBeenCalledWith(
          `update run ${run.runId} terminal notification remained pending`,
        );
      }
    },
  );

  it("stops polling and cannot be woken after teardown while sibling jobs remain live", async () => {
    beginRun();
    const initial = nextBroadcast();
    watcher = startWatcher();
    await initial;
    const sibling = vi.fn();
    scheduler.schedule({ id: "sibling", delayMs: 1_000, run: sibling });
    await watcher.stop();
    const reads = ledger.reads.mock.calls.length;
    await clock.advanceBy(60_000);
    expect(sibling).toHaveBeenCalledOnce();
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
    expect(broadcast).toHaveBeenCalledOnce();
    wakeUpdateRunWatcher();
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
  });
});
