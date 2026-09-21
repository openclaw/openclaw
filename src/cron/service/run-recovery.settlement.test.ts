import { deserialize } from "node:v8";
import { MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { clearCronJobActive, markCronJobActive } from "../active-jobs.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import {
  inspectActiveCronRunReceipt,
  makeCronRecoveryJob,
} from "../store/run-receipt-store.test-support.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import { stop } from "./ops-lifecycle.js";
import { ensureLoadedForRead } from "./ops-shared.js";
import { makeCronRecoveryState } from "./run-recovery.test-support.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { createCronServiceState, type CronEvent } from "./state.js";
import { tryCreateCronTaskRunHandle } from "./task-runs.js";
import { onTimer } from "./timer.test-support.js";

function loseFirstCronMutationReply(
  type: "cron.repairRun" | "cron.scheduleUnowned" = "cron.repairRun",
) {
  let target: { worker: Worker; requestId: number; nonce: string } | undefined;
  let stopped: Promise<number> | undefined;
  let dropped = false;
  const attempts: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
  const originalPost = Worker.prototype.postMessage;
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted message port remains the receiver.
  const originalOn = MessagePort.prototype.on;
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (
        isRecord(command) &&
        command.type === type &&
        isRecord(command.input) &&
        typeof command.input.nonce === "string"
      ) {
        attempts.push(
          isRecord(command.input.proposal) && typeof command.input.proposal.jobId === "string"
            ? command.input.proposal.jobId
            : type,
        );
        target ??= { worker: this, requestId: request.id, nonce: command.input.nonce };
      }
    }
    return originalPost.call(this, request, transferList);
  });
  const on = vi
    .spyOn(MessagePort.prototype, "on")
    .mockImplementation(function (this: MessagePort, event, listener) {
      if (event !== "message") {
        return originalOn.call(this, event, listener);
      }
      return originalOn.call(this, event, function (this: MessagePort, ...args: unknown[]) {
        const message = args[0];
        const reply = isRecord(message) && message.type === "result" ? message.reply : undefined;
        if (
          !dropped &&
          target &&
          isRecord(reply) &&
          reply.id === target.requestId &&
          reply.ok === true &&
          reply.value instanceof Uint8Array
        ) {
          const result: unknown = deserialize(reply.value);
          if (isRecord(result) && result.nonce === target.nonce) {
            // Withhold only the successful reply; real commit receipts and native settlement still flow.
            dropped = true;
            stopped = target.worker.terminate();
            return;
          }
        }
        Reflect.apply(listener, this, args);
      });
    });
  return {
    attempts,
    wasDropped: () => dropped,
    waitForExit: () => stopped,
    async close() {
      if (target) {
        stopped ??= target.worker.terminate();
      }
      await stopped;
      post.mockRestore();
      on.mockRestore();
    },
  };
}

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-recovery-settlement-" });

it("publishes a committed repair once after reply loss and leaves the remaining batch for the next tick", async () => {
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
    const startedAtMs = job.state.runningAtMs!;
    const prepared = prepareCronRunReceiptClaim({ storePath, job, agentId: "alpha", startedAtMs });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabase({ database: db, prepared, resolveAgentId: () => "alpha" }),
    );
    job.state.runningReceiptId = receipt.receiptId;
    expect(
      tryCreateCronTaskRunHandle({ state, job, startedAt: startedAtMs, runReceipt: receipt }),
    ).toBeDefined();
    releaseLocalCronRunReceiptOwnership(receipt);
  }
  await writeCronStoreSnapshot({ storePath, jobs });
  const history = (jobId: string) =>
    readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId }).entries;
  const finishedIds = () =>
    onEvent.mock.calls.flatMap(([event]) => (event.action === "finished" ? [event.jobId] : []));
  const notificationKeys = () =>
    enqueueSystemEvent.mock.calls.map(([, options]) => options.contextKey);
  const rootWorkBefore = getActiveGatewayRootWorkCount();
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
  await reply.waitForExit();
  expect(reply.wasDropped()).toBe(true);
  expect(reply.attempts).toEqual(["first"]);
  expect(finishedIds()).toEqual(["first"]);
  expect(notificationKeys()).toEqual(["cron:first:failure-alert"]);
  const afterLoss = await loadCronStore(storePath);
  expect(afterLoss.jobs[0]?.state).toMatchObject({ lastRunStatus: "error", consecutiveErrors: 1 });
  expect(afterLoss.jobs[0]?.state.runningAtMs).toBeUndefined();
  expect(afterLoss.jobs[1]?.state.runningAtMs).toBe(jobs[1]!.state.runningAtMs);
  expect(inspectActiveCronRunReceipt({ storePath, jobId: "first" })).toBeUndefined();
  expect(inspectActiveCronRunReceipt({ storePath, jobId: "second" })?.receiptId).toBe(
    jobs[1]!.state.runningReceiptId,
  );
  expect(history("first")).toEqual([expect.objectContaining({ jobId: "first", status: "error" })]);
  expect(history("second")).toEqual([]);

  const secondTick = onTimer(state);
  pending.push(secondTick);
  await secondTick;
  expect(reply.attempts).toEqual(["first", "second"]);
  expect(finishedIds()).toEqual(["first", "second"]);
  expect(notificationKeys()).toEqual(["cron:first:failure-alert", "cron:second:failure-alert"]);
  for (const job of jobs) {
    expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
    expect(history(job.id)).toEqual([expect.objectContaining({ jobId: job.id, status: "error" })]);
  }
  expect(runner).not.toHaveBeenCalled();
  expect(state.activeTimerTicks).toBe(0);
  expect(getActiveGatewayRootWorkCount()).toBe(rootWorkBefore);
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
  const post = vi
    .spyOn(MessagePort.prototype, "postMessage")
    .mockImplementation(function (this: MessagePort, value, transferList) {
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
