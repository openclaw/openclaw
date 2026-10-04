import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../../test/helpers/cron/runtime-mutation.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { clearCronJobActive, markCronJobActive } from "../active-jobs.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { releaseLocalCronRunReceiptOwnership } from "../store/run-receipt-store.js";
import {
  inspectActiveCronRunReceipt,
  makeCronRecoveryJob,
} from "../store/run-receipt-store.test-support.js";
import { stop } from "./ops-lifecycle.js";
import { ensureLoadedForRead } from "./ops-shared.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import {
  claimCronRecoveryReceipt,
  makeCronRecoveryState,
  observeCronRecoveryForTest,
  observeCronTimerAdmissions,
} from "./run-recovery.test-support.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { createCronServiceState, type CronEvent } from "./state.js";
import { onTimer } from "./timer.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-recovery-settlement-" });

it("publishes every committed batch repair once after reply loss", async () => {
  const { storePath } = await makeStorePath();
  const nowMs = Date.now();
  const jobs = ["first", "second"].map((id, index) => {
    const job = makeCronRecoveryJob(id, nowMs - 1_000 + index);
    job.enabled = false;
    job.delivery = { mode: "announce", channel: "last" };
    job.failureAlert = { after: 1, cooldownMs: 0 };
    return job;
  });
  const enqueueSystemEvent = vi.fn();
  const onEvent = vi.fn<(event: CronEvent) => void>();
  const runner = vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    defaultAgentId: "alpha",
    isAgentAvailable: () => true,
    nowMs: () => nowMs,
    log: logger,
    enqueueSystemEvent,
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: runner,
    runCommandJob: runner,
    onEvent,
  });
  await writeCronStoreSnapshot({ storePath, jobs });
  for (const job of jobs) {
    const receipt = claimCronRecoveryReceipt(storePath, job, job.state.runningAtMs!);
    job.state.runningReceiptId = receipt.receiptId;
    releaseLocalCronRunReceiptOwnership(receipt);
  }
  await writeCronStoreSnapshot({ storePath, jobs });
  const history = (jobId: string) =>
    readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId }).entries;
  const finishedIds = () =>
    onEvent.mock.calls.flatMap(([event]) => (event.action === "finished" ? [event.jobId] : []));
  const notificationKeys = () =>
    enqueueSystemEvent.mock.calls.map(([, options]) => options.contextKey);

  const admissions = observeCronTimerAdmissions(state);
  const reply = loseFirstCronMutationReply();
  const pending: Promise<unknown>[] = [];
  onTestFinished(async () => {
    await reply.close();
    stop(state);
    await Promise.allSettled(pending);
    await state.op;
  });

  const firstTick = onTimer(state);
  pending.push(firstTick);
  await expect(firstTick).rejects.toBeInstanceOf(Error);
  await admissions.expectReleased(1);
  await reply.waitForExit();
  expect(reply.wasDropped()).toBe(true);
  expect(reply.attempts).toEqual(["first"]);
  expect(finishedIds()).toEqual(["first", "second"]);
  expect(notificationKeys()).toEqual(["cron:first:failure-alert", "cron:second:failure-alert"]);
  const afterLoss = await loadCronStore(storePath);
  expect(afterLoss.jobs[0]?.state).toMatchObject({ lastRunStatus: "error", consecutiveErrors: 1 });
  expect(afterLoss.jobs[0]?.state.runningAtMs).toBeUndefined();
  expect(afterLoss.jobs[1]?.state).toMatchObject({ lastRunStatus: "error", consecutiveErrors: 1 });
  expect(afterLoss.jobs[1]?.state.runningAtMs).toBeUndefined();
  expect(history("first")).toEqual([expect.objectContaining({ jobId: "first", status: "error" })]);

  const secondTick = onTimer(state);
  pending.push(secondTick);
  await secondTick;
  expect(reply.attempts).toEqual(["first"]);
  expect(finishedIds()).toEqual(["first", "second"]);
  expect(notificationKeys()).toEqual(["cron:first:failure-alert", "cron:second:failure-alert"]);
  for (const job of jobs) {
    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
    expect(history(job.id)).toEqual([expect.objectContaining({ jobId: job.id, status: "error" })]);
  }
  expect(runner).not.toHaveBeenCalled();
  expect(state.activeTimerTicks).toBe(0);

  await admissions.expectReleased(2);
});

it("publishes committed schedule maintenance once after its successful reply is lost", async () => {
  const { storePath } = await makeStorePath();
  const nowMs = Date.now();
  const job = makeCronRecoveryJob("invalid-schedule", nowMs);
  job.schedule = { kind: "cron", expr: "invalid" };
  job.state = { scheduleErrorCount: 2 };
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  const enqueueSystemEvent = vi.fn();
  const state = makeCronRecoveryState(logger, storePath, nowMs, { enqueueSystemEvent });
  const reply = loseFirstCronMutationReply("cron.scheduleUnowned");
  onTestFinished(async () => {
    await reply.close();
    stop(state);
    await state.op;
  });
  await expect(ensureLoadedForRead(state)).rejects.toBeInstanceOf(Error);
  await reply.waitForExit();
  expect(reply.wasDropped()).toBe(true);
  expect(state.store?.jobs[0]).toMatchObject({ enabled: false, state: { scheduleErrorCount: 3 } });
  expect((await loadCronStore(storePath)).jobs[0]).toEqual(state.store?.jobs[0]);
  expect(enqueueSystemEvent).toHaveBeenCalledOnce();
  expect(enqueueSystemEvent.mock.calls[0]?.[1].contextKey).toBe(
    "cron:invalid-schedule:auto-disabled",
  );
  await ensureLoadedForRead(state);
  expect(enqueueSystemEvent).toHaveBeenCalledOnce();
  expect(reply.attempts).toHaveLength(2);
});

it("rolls schedule maintenance back when process ownership changes before commit", async () => {
  const { storePath } = await makeStorePath();
  const nowMs = Date.now();
  const job = makeCronRecoveryJob("became-active", nowMs);
  job.enabled = false;
  job.state = { runningAtMs: nowMs - 1_000 };
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  const before = await loadCronStore(storePath);
  const state = makeCronRecoveryState(logger, storePath, nowMs);
  let activated = false;
  // oxlint-disable-next-line typescript/unbound-method -- The private port remains the receiver.
  const originalPost = MessagePort.prototype.postMessage;
  const post = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
    this: MessagePort,
    value,
    transferList,
  ) {
    if (isRecord(value) && Array.isArray(value.ownership)) {
      markCronJobActive(job.id);
      activated = true;
    }
    return originalPost.call(this, value, transferList);
  });
  try {
    await expect(recomputeUnownedCronSchedules(state)).rejects.toThrow(
      "Cron schedule ownership changed before commit",
    );
    expect(activated).toBe(true);
    expect(await loadCronStore(storePath)).toEqual(before);
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  } finally {
    post.mockRestore();
    clearCronJobActive(job.id);
    stop(state);
  }
});

it("commits a recovery batch before publishing its first result", async () => {
  const { storePath } = await makeStorePath();
  const startedAtMs = Date.parse("2026-08-13T14:00:00.000Z");
  const jobs = [
    makeCronRecoveryJob("batch-first", startedAtMs),
    makeCronRecoveryJob("batch-second", startedAtMs + 1),
  ];
  await writeCronStoreSnapshot({ storePath, jobs });
  const receipts = jobs.map((job, index) =>
    claimCronRecoveryReceipt(storePath, job, startedAtMs + index),
  );
  for (const receipt of receipts) {
    releaseLocalCronRunReceiptOwnership(receipt);
  }
  const state = makeCronRecoveryState(logger, storePath, startedAtMs + 30_000);
  const proposals = await Promise.all(
    jobs.map((job, index) =>
      observeCronRecoveryForTest(state, job.id, undefined, startedAtMs + index),
    ),
  );
  const results: string[] = [];

  await recoverCronRunProposals(state, proposals, {
    mode: "startup",
    onRecovery(proposal, result) {
      results.push(`${proposal.jobId}:${result.kind}`);
      // A published batch is already durable: a listener may inspect either job.
      expect(inspectActiveCronRunReceipt({ storePath, jobId: jobs[1]!.id })).toBeUndefined();
    },
  });

  expect(results).toEqual(["batch-first:repaired", "batch-second:repaired"]);
  const persisted = await loadCronStore(storePath);
  expect(persisted.jobs.map((job) => job.state.lastRunStatus)).toEqual(["error", "error"]);
});

it.each(["listener", "logger"] as const)(
  "publishes every committed batch result before surfacing a %s failure",
  async (failing) => {
    const { storePath } = await makeStorePath();
    const startedAtMs = Date.parse("2026-08-13T14:00:00.000Z");
    const jobs = [
      makeCronRecoveryJob("batch-first", startedAtMs),
      makeCronRecoveryJob("batch-second", startedAtMs + 1),
    ];
    await writeCronStoreSnapshot({ storePath, jobs });
    const receipts = jobs.map((job, index) =>
      claimCronRecoveryReceipt(storePath, job, startedAtMs + index),
    );
    for (const receipt of receipts) {
      releaseLocalCronRunReceiptOwnership(receipt);
    }
    const state = makeCronRecoveryState(logger, storePath, startedAtMs + 30_000);
    const proposals = await Promise.all(
      jobs.map((job, index) =>
        observeCronRecoveryForTest(state, job.id, undefined, startedAtMs + index),
      ),
    );
    const results: string[] = [];
    const failure = new Error(`recovery ${failing} failed`);
    // Arm after the first result is published so the throw lands in that result's log replay.
    let loggerArmed = false;
    const levels = ["debug", "info", "warn", "error"] as const;
    if (failing === "logger") {
      for (const level of levels) {
        logger[level].mockImplementation(() => {
          if (loggerArmed) {
            loggerArmed = false;
            throw failure;
          }
        });
      }
    }

    try {
      await expect(
        recoverCronRunProposals(state, proposals, {
          mode: "startup",
          onRecovery(proposal, result) {
            results.push(`${proposal.jobId}:${result.kind}`);
            if (results.length === 1 && failing === "listener") {
              throw failure;
            }
            loggerArmed = results.length === 1;
          },
        }),
      ).rejects.toBe(failure);
    } finally {
      for (const level of levels) {
        logger[level].mockReset();
      }
    }

    expect(results).toEqual(["batch-first:repaired", "batch-second:repaired"]);
    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs.map((job) => job.state.lastRunStatus)).toEqual(["error", "error"]);
  },
);
