import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  run: undefined as
    | Pick<UpdateRunRecord, "runId" | "phase" | "status" | "updatedAtMs" | "steps" | "origin">
    | undefined,
  reads: vi.fn(),
  reconcile: vi.fn<() => Promise<UpdateRunRecord[]>>(),
  notice: vi.fn(async (_run: UpdateRunRecord) => {}),
}));
vi.mock("../state/openclaw-state-db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db.js")>()),
  reconcileOpenClawStateSchemaPublication: () => undefined,
}));
vi.mock("../infra/update-run-interruption.js", () => ({
  reconcileInterruptedUpdateRuns: ledger.reconcile,
}));
vi.mock("./update-run-notice.runtime.js", () => ({ notifyUpdateRunPhase: ledger.notice }));
vi.mock("../infra/update-run-ledger.js", () => ({
  reconcileAbandonedUpdateRuns: () => [],
  findActiveUpdateRun: () => {
    ledger.reads();
    return ledger.run?.status === "running" ? ledger.run : undefined;
  },
  getUpdateRun: () => {
    ledger.reads();
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
  ledger.reads.mockClear();
  ledger.reconcile.mockReset().mockResolvedValue([]);
  ledger.notice.mockClear();
});
afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  await lifecycle.stop();
  await scheduler.stop();
});

function beginRun() {
  ledger.run = {
    runId: "b7150827-8222-4c12-bd20-9bfd6ae8e852",
    phase: "requested",
    status: "running",
    updatedAtMs: 1,
    steps: [],
    origin: {},
  };
}

function currentRunEvent() {
  const { runId, phase, status, updatedAtMs } = ledger.run!;
  return { runId, phase, status, updatedAtMs };
}

describe("Gateway update run watcher", () => {
  it("clears a campaign created after watcher startup before publishing its terminal run", async () => {
    beginRun();
    const onChange = vi.fn();
    const campaign = new UpdateCampaignController(scheduler);
    const broadcast = vi.fn(() => {
      if (ledger.run!.status === "failed") {
        expect(campaign.getState()).toBeUndefined();
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
    await clock.advanceBy(0);
    ledger.run = { ...ledger.run!, status: "failed", phase: "finished", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
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
      await clock.advanceBy(4_000);
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

  it("leaves pre-acknowledgement refusal reporting to the command", async () => {
    beginRun();
    const broadcast = vi.fn();
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
    ledger.run = { ...ledger.run!, phase: "finished", status: "failed", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", {
      runId: ledger.run.runId,
      phase: "finished",
      status: "failed",
      updatedAtMs: 2,
    });
    expect(ledger.notice).not.toHaveBeenCalled();
  });
  it("wakes for admission, broadcasts changed rows, and stops polling after the terminal event", async () => {
    const broadcast = vi.fn();
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
    await clock.advanceBy(10_000);
    expect(ledger.reads).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();

    beginRun();
    wakeUpdateRunWatcher();
    await clock.advanceBy(0);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    await clock.advanceBy(2_000);
    expect(broadcast).toHaveBeenCalledOnce();
    ledger.run = { ...ledger.run!, phase: "staging", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    ledger.run = { ...ledger.run!, phase: "finished", status: "succeeded", updatedAtMs: 3 };
    await clock.advanceBy(2_000);
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    const reads = ledger.reads.mock.calls.length;
    await clock.advanceBy(60_000);
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it("broadcasts a terminal repair after an update has remained running for over 45 minutes", async () => {
    beginRun();
    ledger.run!.steps = [{ step: "notice:ack", status: "completed" }];
    const broadcast = vi.fn();
    const delivered = createDeferredCore();
    ledger.notice.mockImplementationOnce(async () => {
      delivered.resolve();
    });
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
    await clock.advanceBy(0);
    const beforeSleep = ledger.reads.mock.calls.length;
    const catchUp = clock.advanceBy(46 * 60_000);
    expect(ledger.reads).toHaveBeenCalledTimes(beforeSleep + 1);
    await catchUp;
    ledger.run = { ...ledger.run!, phase: "finished", status: "failed", updatedAtMs: 2 };
    await clock.advanceBy(2_000);
    await delivered.promise;
    expect(broadcast).toHaveBeenLastCalledWith("update.run.changed", currentRunEvent());
    expect(ledger.notice).toHaveBeenCalledExactlyOnceWith(ledger.run);
    const reads = ledger.reads.mock.calls.length;
    await clock.advanceBy(60_000);
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
  });

  it("stops polling and cannot be woken after teardown", async () => {
    beginRun();
    const broadcast = vi.fn();
    watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
    await clock.advanceBy(0);
    await watcher.stop();
    const reads = ledger.reads.mock.calls.length;
    await clock.advanceBy(60_000);
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
    expect(broadcast).toHaveBeenCalledOnce();
    wakeUpdateRunWatcher();
    expect(ledger.reads).toHaveBeenCalledTimes(reads);
  });
});
