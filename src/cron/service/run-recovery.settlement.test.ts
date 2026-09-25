import { deserialize } from "node:v8";
import { MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import { captureTaskDeliveryWork } from "../../tasks/task-registry-delivery.test-support.js";
import { clearCronJobActive, markCronJobActive } from "../active-jobs.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  inspectActiveCronRunReceipt,
  makeCronRecoveryJob,
} from "../store/run-receipt-store.test-support.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import { stop } from "./ops-lifecycle.js";
import { ensureLoadedForRead } from "./ops-shared.js";
import {
  createCronRecoveryFixture,
  makeCronRecoveryState,
  observeCronTimerAdmissions,
  seedInterruptedCronJobs,
} from "./run-recovery.test-support.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { createCronServiceState, type CronEvent } from "./state.js";
import { onTimer } from "./timer.test-support.js";

function loseFirstCronMutationReply(
  track: (completion: Promise<number>) => Promise<number>,
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
  const on = vi.spyOn(MessagePort.prototype, "on").mockImplementation(function (
    this: MessagePort,
    event,
    listener,
  ) {
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
          stopped = track(target.worker.terminate());
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
        stopped ??= track(target.worker.terminate());
      }
      await stopped;
      post.mockRestore();
      on.mockRestore();
    },
  };
}

const suite = setupCronServiceSuite({ prefix: "cron-recovery-settlement-" });
const { logger } = suite;

describe("", () => {
  const fixtures = createCronRecoveryFixture(suite, onTestFinished);
  afterEach(() => fixtures.finishAfterEach());
  it("publishes a committed repair once after reply loss and leaves the remaining batch for the next tick", async () =>
    fixtures.run(async (fixture) => {
      const deliveries = captureTaskDeliveryWork();
      fixture.cleanup(async () => {
        try {
          await deliveries.settle();
        } finally {
          deliveries[Symbol.dispose]();
        }
      });
      const { storePath } = await fixture.makeStorePath();
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
      await seedInterruptedCronJobs(state, jobs);
      const history = (jobId: string) =>
        readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId }).entries;
      const finishedIds = () =>
        onEvent.mock.calls.flatMap(([event]) => (event.action === "finished" ? [event.jobId] : []));
      const notificationKeys = () =>
        enqueueSystemEvent.mock.calls.map(([, options]) => options.contextKey);
      await deliveries.settle();
      const admissions = observeCronTimerAdmissions(state);
      fixture.state(state);
      const reply = loseFirstCronMutationReply((work) => fixture.track(work));
      fixture.release(() => reply.close());

      const firstTick = fixture.track(onTimer(state));
      await expect(firstTick).rejects.toBeInstanceOf(Error);
      await admissions.expectReleased(1);
      await reply.waitForExit();
      expect(reply.wasDropped()).toBe(true);
      expect(reply.attempts).toEqual(["first"]);
      expect(finishedIds()).toEqual(["first"]);
      expect(notificationKeys()).toEqual(["cron:first:failure-alert"]);
      const afterLoss = await loadCronStore(storePath);
      expect(afterLoss.jobs[0]?.state).toMatchObject({
        lastRunStatus: "error",
        consecutiveErrors: 1,
      });
      expect(afterLoss.jobs[0]?.state.runningAtMs).toBeUndefined();
      expect(afterLoss.jobs[1]?.state.runningAtMs).toBe(jobs[1]!.state.runningAtMs);
      expect(inspectActiveCronRunReceipt({ storePath, jobId: "first" })).toBeUndefined();
      expect(inspectActiveCronRunReceipt({ storePath, jobId: "second" })?.receiptId).toBe(
        jobs[1]!.state.runningReceiptId,
      );
      expect(history("first")).toEqual([
        expect.objectContaining({ jobId: "first", status: "error" }),
      ]);
      expect(history("second")).toEqual([]);

      const secondTick = fixture.track(onTimer(state));
      await secondTick;
      expect(reply.attempts).toEqual(["first", "second"]);
      expect(finishedIds()).toEqual(["first", "second"]);
      expect(notificationKeys()).toEqual(["cron:first:failure-alert", "cron:second:failure-alert"]);
      for (const job of jobs) {
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
        expect(history(job.id)).toEqual([
          expect.objectContaining({ jobId: job.id, status: "error" }),
        ]);
      }
      expect(runner).not.toHaveBeenCalled();
      expect(state.activeTimerTicks).toBe(0);
      await deliveries.settle();
      await admissions.expectReleased(2);
    }));

  it("publishes committed schedule maintenance once after its successful reply is lost", async () =>
    fixtures.run(async (fixture) => {
      const { storePath } = await fixture.makeStorePath();
      const nowMs = Date.now();
      const job = makeCronRecoveryJob("invalid-schedule", nowMs);
      job.schedule = { kind: "cron", expr: "invalid" };
      job.state = { scheduleErrorCount: 2 };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const enqueueSystemEvent = vi.fn();
      const state = fixture.state(
        makeCronRecoveryState(logger, storePath, nowMs, { enqueueSystemEvent }),
      );
      const reply = loseFirstCronMutationReply(
        (work) => fixture.track(work),
        "cron.scheduleUnowned",
      );
      fixture.release(() => reply.close());

      await expect(fixture.track(ensureLoadedForRead(state))).rejects.toBeInstanceOf(Error);
      await reply.waitForExit();
      expect(reply.wasDropped()).toBe(true);
      expect(state.store?.jobs[0]).toMatchObject({
        enabled: false,
        state: { scheduleErrorCount: 3 },
      });
      expect((await loadCronStore(storePath)).jobs[0]).toEqual(state.store?.jobs[0]);
      expect(enqueueSystemEvent).toHaveBeenCalledOnce();
      expect(enqueueSystemEvent.mock.calls[0]?.[1].contextKey).toBe(
        "cron:invalid-schedule:auto-disabled",
      );
      await fixture.track(ensureLoadedForRead(state));
      expect(enqueueSystemEvent).toHaveBeenCalledOnce();
      expect(reply.attempts).toHaveLength(2);
    }));

  it("rolls schedule maintenance back when process ownership changes before commit", async () =>
    fixtures.run(async (fixture) => {
      const { storePath } = await fixture.makeStorePath();
      const nowMs = Date.now();
      const job = makeCronRecoveryJob("became-active", nowMs);
      job.enabled = false;
      job.state = { runningAtMs: nowMs - 1_000 };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const before = await loadCronStore(storePath);
      const state = fixture.state(makeCronRecoveryState(logger, storePath, nowMs));
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
      fixture.cleanup(async () => {
        post.mockRestore();
        clearCronJobActive(job.id);
        stop(state);
      });
      await expect(fixture.track(recomputeUnownedCronSchedules(state))).rejects.toThrow(
        "Cron schedule ownership changed before commit",
      );
      expect(activated).toBe(true);
      expect(await loadCronStore(storePath)).toEqual(before);
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    }));
});
