import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { UpdateCampaignController } from "../infra/update-campaign.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../infra/update-check-lifecycle.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startUpdateRunWatcher, wakeUpdateRunWatcher } from "./update-run-watcher.js";

const ledger = vi.hoisted(() => ({
  run: undefined as UpdateRunRecord | undefined,
  reads: vi.fn<(kind: "run" | "status") => void>(),
  reconcile:
    vi.fn<
      (
        input: { signal?: AbortSignal },
        onCandidate?: (runId: string) => void,
      ) => Promise<UpdateRunRecord[]>
    >(),
  notice: vi.fn(async (_run: UpdateRunRecord) => {}),
  sentinel: vi.fn<() => Promise<RestartSentinelPayload | null>>(),
}));
vi.mock("../state/openclaw-state-db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db.js")>()),
  reconcileOpenClawStateSchemaPublication: () => undefined,
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
beforeEach(() => {
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
  lifecycle = createGatewayUpdateLifecycle(scheduler);
  ledger.run = undefined;
  ledger.reads.mockReset();
  ledger.reconcile.mockReset().mockResolvedValue([]);
  ledger.notice.mockReset().mockResolvedValue(undefined);
  ledger.sentinel.mockReset().mockResolvedValue(null);
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
  it("clears a campaign created after watcher startup before publishing its terminal run", async () => {
    beginRun();
    const onChange = vi.fn();
    const campaign = new UpdateCampaignController(scheduler);
    const initial = createDeferredCore();
    const terminal = createDeferredCore();
    const broadcast = vi.fn(() => {
      if (ledger.run!.status === "failed") {
        terminal.resolve();
        expect(campaign.getState()).toBeUndefined();
      } else {
        initial.resolve();
      }
    });
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
    lifecycle.campaign = campaign;
    campaign.announce({
      target: { kind: "package", version: "2026.9.6" },
      apply: async () => "applied",
      onChange,
    });
    campaign.adopt();
    ledger.run!.origin = { campaignId: campaign.getState()!.id };
    await initial.promise;
    ledger.run = { ...ledger.run!, status: "failed", phase: "finished", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    await terminal.promise;
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
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
    watcher = startUpdateRunWatcher({ lifecycle, broadcast: vi.fn(), log: { warn: vi.fn() } });
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
      .mockImplementationOnce(async () => {
        activatingNotice.resolve();
      })
      .mockImplementationOnce(async () => {
        finishedNotice.resolve();
      });
    const broadcast = vi.fn();
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
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

  it.each(["same revision", "successor completed", "newer correction"] as const)(
    "publishes a held verification result once while preserving %s",
    async (scenario) => {
      const first = beginRun();
      first.phase = "verifying";
      first.steps = [{ step: "notice:ack", status: "completed" }];
      const initialBroadcast = createDeferredCore();
      const selectCandidate = createDeferredCore();
      const candidateSelected = createDeferredCore();
      const verification = createDeferredCore<UpdateRunRecord[]>();
      const nextCycle = createDeferredCore();
      const firstNotice = createDeferredCore();
      const successorNotice = createDeferredCore();
      const correctionNotice = createDeferredCore();
      ledger.reconcile
        .mockImplementationOnce(async (_input, onCandidate) => {
          await selectCandidate.promise;
          onCandidate?.(first.runId);
          candidateSelected.resolve();
          return await verification.promise;
        })
        .mockImplementationOnce(async () => {
          nextCycle.resolve();
          return [];
        });
      ledger.notice.mockImplementation(async (run) => {
        if (run.runId !== first.runId) {
          successorNotice.resolve();
        } else if (run.updatedAtMs === 2) {
          firstNotice.resolve();
        } else {
          correctionNotice.resolve();
        }
      });
      const broadcast = vi.fn().mockImplementationOnce(() => initialBroadcast.resolve());
      watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
      try {
        await initialBroadcast.promise;
        const terminal: UpdateRunRecord = {
          ...first,
          phase: "finished",
          status: scenario === "newer correction" ? "failed" : "succeeded",
          reason: scenario === "newer correction" ? "abandoned" : null,
          updatedAtMs: 2,
          finishedAtMs: 2,
        };
        if (scenario === "newer correction") {
          // This cycle selects the already abandoned row and may later correct it.
          ledger.run = terminal;
        }
        selectCandidate.resolve();
        await candidateSelected.promise;
        // The row is committed, but this verification cycle still holds its reply.
        ledger.run = terminal;
        await clock.advanceBy(2_000);
        await firstNotice.promise;

        if (scenario === "successor completed") {
          const successorBroadcast = createDeferredCore();
          broadcast.mockImplementationOnce(() => successorBroadcast.resolve());
          const successor = beginRun("aa688074-cb7a-4fb8-ae6a-e099e37e1d20");
          successor.steps = [{ step: "notice:ack", status: "completed" }];
          wakeUpdateRunWatcher();
          await successorBroadcast.promise;
          ledger.run = {
            ...successor,
            phase: "finished",
            status: "succeeded",
            updatedAtMs: 4,
            finishedAtMs: 4,
          };
          await clock.advanceBy(2_000);
          await successorNotice.promise;
        }

        const settled: UpdateRunRecord =
          scenario === "newer correction"
            ? { ...terminal, status: "succeeded", reason: null, updatedAtMs: 3, finishedAtMs: 3 }
            : terminal;
        if (scenario === "newer correction") {
          ledger.run = settled;
        }
        verification.resolve([settled]);
        if (scenario === "newer correction") {
          await correctionNotice.promise;
        }
        // A follow-up cycle starts only after the held result's scan has completed.
        await nextCycle.promise;
        await watcher.stop();
        const revisions = scenario === "newer correction" ? [2, 3] : [2];
        expect(
          broadcast.mock.calls
            .filter(([, run]) => run.runId === first.runId && run.status !== "running")
            .map(([, run]) => run.updatedAtMs),
        ).toEqual(revisions);
        expect(
          ledger.notice.mock.calls
            .filter(([run]) => run.runId === first.runId)
            .map(([run]) => run.updatedAtMs),
        ).toEqual(revisions);
        if (scenario === "successor completed") {
          expect(
            broadcast.mock.calls.filter(
              ([, run]) => run.runId !== first.runId && run.status !== "running",
            ),
          ).toHaveLength(1);
          expect(
            ledger.notice.mock.calls.filter(([run]) => run.runId !== first.runId),
          ).toHaveLength(1);
        }
      } finally {
        selectCandidate.resolve();
        verification.resolve([]);
        await watcher.stop();
      }
    },
  );

  it("leaves pre-acknowledgement refusal reporting to the command", async () => {
    beginRun();
    const initial = createDeferredCore();
    const terminal = createDeferredCore();
    const broadcast = vi
      .fn()
      .mockImplementationOnce(() => initial.resolve())
      .mockImplementationOnce(() => terminal.resolve());
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
    await initial.promise;
    const idle = nextLedgerRead("status");
    ledger.run = { ...ledger.run!, phase: "finished", status: "failed", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    await terminal.promise;
    await idle;
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", {
      runId: ledger.run.runId,
      phase: "finished",
      status: "failed",
      updatedAtMs: 2,
    });
    expect(ledger.notice).not.toHaveBeenCalled();
  });
  it("wakes for admission, broadcasts changed rows, and stops polling after the terminal event", async () => {
    const initialRead = nextLedgerRead("status");
    const requested = createDeferredCore();
    const staging = createDeferredCore();
    const terminal = createDeferredCore();
    const broadcast = vi
      .fn()
      .mockImplementationOnce(() => requested.resolve())
      .mockImplementationOnce(() => staging.resolve())
      .mockImplementationOnce(() => terminal.resolve());
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
    await clock.advanceBy(10_000);
    await initialRead;
    expect(ledger.reads).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();

    beginRun();
    wakeUpdateRunWatcher();
    await requested.promise;
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    const unchanged = nextPollSchedule();
    await clock.advanceBy(2_000);
    await unchanged;
    expect(broadcast).toHaveBeenCalledOnce();
    ledger.run = { ...ledger.run!, phase: "staging", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    await staging.promise;
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    const idle = nextLedgerRead("status");
    ledger.run = { ...ledger.run!, phase: "finished", status: "succeeded", updatedAtMs: 3 };
    await clock.advanceBy(2_000);
    await terminal.promise;
    await idle;
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    const reads = ledger.reads.mock.calls.length;
    await clock.advanceBy(60_000);
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it.each(["published", "unavailable", "timed-out", "superseded"] as const)(
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
      const initial = createDeferredCore();
      const terminal = createDeferredCore();
      const settled = createDeferredCore();
      const idle = createDeferredCore();
      const broadcast = vi
        .fn()
        .mockImplementationOnce(() => initial.resolve())
        .mockImplementationOnce(() => terminal.resolve())
        .mockImplementationOnce(() => {
          if (outcome !== "superseded") {
            void nextLedgerRead("status").then(() => idle.resolve());
          }
          settled.resolve();
        });
      const warn = vi.fn();
      watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn } });
      await initial.promise;
      ledger.run = { ...run, status: "failed", phase: "finished", updatedAtMs: 2 };
      if (outcome === "unavailable") {
        ledger.sentinel.mockRejectedValueOnce(new Error("state unavailable"));
      }
      await clock.advanceBy(2_000);
      await terminal.promise;
      expect(scheduler.nextWakeAtMs).not.toBeNull();
      if (outcome === "superseded") {
        beginRun("aa688074-cb7a-4fb8-ae6a-e099e37e1d20");
        ledger.sentinel.mockResolvedValue(null);
        await clock.advanceBy(2_000);
        await settled.promise;
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
      await settled.promise;
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

  it("broadcasts a terminal repair after an update has remained running for over 45 minutes", async () => {
    beginRun();
    ledger.run!.steps = [{ step: "notice:ack", status: "completed" }];
    const initial = createDeferredCore();
    const broadcast = vi.fn().mockImplementationOnce(() => initial.resolve());
    const delivered = createDeferredCore();
    ledger.notice.mockImplementationOnce(async () => {
      delivered.resolve();
    });
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
    await initial.promise;
    await nextPollSchedule();
    const beforeSleep = ledger.reads.mock.calls.length;
    const entered = nextLedgerRead("run");
    const rearmed = nextPollSchedule();
    const catchUp = clock.advanceBy(46 * 60_000);
    await entered;
    expect(ledger.reads).toHaveBeenCalledTimes(beforeSleep + 1);
    await catchUp;
    await rearmed;
    const idle = nextLedgerRead("status");
    ledger.run = { ...ledger.run!, phase: "finished", status: "failed", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    await delivered.promise;
    await idle;
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    expect(ledger.notice).toHaveBeenCalledExactlyOnceWith(ledger.run);
    const reads = ledger.reads.mock.calls.length;
    await clock.advanceBy(60_000);
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
  });

  it("stops polling and cannot be woken after teardown while sibling jobs remain live", async () => {
    beginRun();
    const initial = createDeferredCore();
    const broadcast = vi.fn(() => initial.resolve());
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
    await initial.promise;
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
