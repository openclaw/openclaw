import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunRecordsForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import type { CronEvent } from "./service.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { loadCronStore } from "./store.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import type { CronJobExecutionResult, CronRunOutcome } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-session-payload-" });

describe("ordinary session payload settlement", () => {
  it.each(["ok", "error"] as const)(
    "records %s only after the shared session turn settles",
    async (status) => {
      const store = await makeStorePath();
      const entered = createDeferred();
      const child = createDeferred<CronRunOutcome>();
      const events: CronEvent[] = [];
      const { cron, enqueueSystemEvent, enqueueSessionEvent, runSessionEvent } =
        createStartedCronServiceWithFinishedBarrier({
          scheduler: createTestGatewayScheduler(),
          storePath: store.storePath,
          logger,
          runSessionEvent: async () => {
            entered.resolve();
            return child.promise;
          },
          onEvent: (event) => events.push(event),
        });
      await cron.start();
      const job = await cron.add({
        name: "Check the inbox",
        agentId: "main",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "Check urgent inbox items" },
        sessionTarget: "main",
        wakeMode: "now",
        delivery: { mode: "none" },
      });
      const running = cron.run(job.id, "force");
      try {
        await entered.promise;
        expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            job: expect.objectContaining({ id: job.id }),
            text: "Check urgent inbox items",
            abortSignal: expect.any(AbortSignal),
          }),
        );
        expect(events.some((event) => event.action === "finished")).toBe(false);
        expect(cron.getJob(job.id)?.state.runningAtMs).toEqual(expect.any(Number));
        child.resolve({ status, ...(status === "error" ? { error: "provider unavailable" } : {}) });
        await expect(running).resolves.toMatchObject({ ok: true, ran: true });
        expect(events.filter((event) => event.action === "finished")).toEqual([
          expect.objectContaining({
            status,
            completionStatus: status === "ok" ? "succeeded" : "failed",
          }),
        ]);
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: status,
          consecutiveErrors: status === "error" ? 1 : 0,
        });
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(enqueueSessionEvent).not.toHaveBeenCalled();
      } finally {
        child.resolve({ status: "error", error: "fixture cleanup" });
        await running;
        cron.stop();
      }
    },
  );
});

describe("unstarted scheduled admission", () => {
  it.each(
    (["at", "every", "cron"] as const).flatMap((scheduleKind) =>
      (["preflight", "session", "isolated"] as const).map((boundary) => ({
        scheduleKind,
        boundary,
      })),
    ),
  )(
    "retains a busy $scheduleKind occurrence at $boundary without completion delivery",
    async ({ scheduleKind, boundary }) => {
      const store = await makeStorePath();
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      let busy = true;
      const run = vi.fn(async (): Promise<CronJobExecutionResult> =>
        busy
          ? {
              status: "skipped",
              admissionDeferred: true,
              executionStarted: false,
              summary: "Admission deferred",
            }
          : { status: "ok", executionStarted: true, summary: "Check completed" },
      );
      const sendWebhook = vi.fn(async () => ({ status: "delivered" as const }));
      const events: CronEvent[] = [];
      const cron = new CronService({
        scheduler,
        storePath: store.storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        enqueueSystemEvent: vi.fn(),
        isExecutionIdle: () => boundary !== "preflight" || !busy,
        runSessionEvent: run,
        runIsolatedAgentJob: run,
        sendCronWebhook: sendWebhook,
        onEvent: (event) => events.push(event),
      });
      try {
        const previousRunAt = scheduler.now() - 120_000;
        const job = await cron.add({
          name: `Idle ${scheduleKind} ${boundary}`,
          agentId: "main",
          enabled: true,
          deleteAfterRun: false,
          schedule:
            scheduleKind === "at"
              ? { kind: "at", at: new Date(scheduler.now() + 1_000).toISOString() }
              : scheduleKind === "every"
                ? { kind: "every", everyMs: 60_000 }
                : { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 },
          idleOnly: true,
          payload: { kind: "agentTurn", message: "Check once idle" },
          sessionTarget: boundary === "isolated" ? "isolated" : "main",
          wakeMode: "now",
          delivery: { mode: "webhook", to: "https://example.invalid/completed" },
          state: {
            lastRunAtMs: previousRunAt,
            lastRunStatus: "error",
            lastError: "Previous failure",
            consecutiveErrors: 1,
          },
        });
        await cron.start();
        const dueAt = cron.getJob(job.id)!.state.nextRunAtMs!;
        await clock.advanceTo(dueAt);
        const retained = (await loadCronStore(store.storePath)).jobs.find(
          (entry) => entry.id === job.id,
        )!;
        expect(retained).toMatchObject({
          enabled: true,
          state: {
            nextRunAtMs: dueAt,
            lastRunAtMs: previousRunAt,
            lastRunStatus: "error",
            lastError: "Previous failure",
            consecutiveErrors: 1,
          },
        });
        expect(retained.state.runningAtMs).toBeUndefined();
        expect(retained.state.runningReceiptId).toBeUndefined();
        expect(retained.state.queuedAtMs).toBeUndefined();
        expect(
          inspectActiveCronRunReceipt({ storePath: store.storePath, jobId: job.id }),
        ).toBeUndefined();
        expect(readCronRunRecordsForTests(job.id)).toEqual([]);
        expect(events.filter((event) => event.action === "finished")).toEqual([]);
        expect(sendWebhook).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledTimes(boundary === "preflight" ? 0 : 1);
        busy = false;
        const recheckAt = scheduler.nextWakeAtMs;
        expect(recheckAt).toBeTypeOf("number");
        expect(recheckAt).toBeGreaterThan(scheduler.now());
        await clock.advanceTo(recheckAt!);
        expect(run).toHaveBeenCalledTimes(boundary === "preflight" ? 1 : 2);
        expect(sendWebhook).toHaveBeenCalledOnce();
        expect(readCronRunRecordsForTests(job.id)).toHaveLength(1);
        const completed = cron.getJob(job.id)!;
        expect(completed.state.lastRunStatus).toBe("ok");
        if (scheduleKind === "at") {
          expect(completed.enabled).toBe(false);
          expect(completed.state.nextRunAtMs).toBeUndefined();
        } else {
          expect(completed.state.nextRunAtMs).toBeGreaterThan(scheduler.now());
        }
      } finally {
        cron.stop();
        await cron.waitForIdle();
        await scheduler.stop();
      }
    },
  );

  it.each(["execution", "delivery", "trigger"] as const)(
    "does not replay an occurrence after %s began",
    async (effect) => {
      const store = await makeStorePath();
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const result: CronJobExecutionResult = {
        status: "skipped",
        admissionDeferred: true,
        executionStarted: effect === "execution",
        deliveryAttempted: effect === "delivery",
        summary: "Already spent occurrence",
      };
      const run = vi.fn(async () => result);
      const evaluate = vi.fn(async () => ({ kind: "evaluated" as const, fire: true }));
      const cron = new CronService({
        scheduler,
        storePath: store.storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        enqueueSystemEvent: vi.fn(),
        runSessionEvent: run,
        runIsolatedAgentJob: run,
        evaluateCronTrigger: evaluate,
      });
      try {
        const job = await cron.add({
          name: `Retain ${effect} evidence`,
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          ...(effect === "trigger" ? { trigger: { script: "json({fire:true})" } } : {}),
          payload: { kind: "agentTurn", message: "Do not replay started work" },
          sessionTarget: "main",
          wakeMode: "now",
          delivery: { mode: "none" },
        });
        await cron.start();
        const dueAt = cron.getJob(job.id)!.state.nextRunAtMs!;
        await clock.advanceTo(dueAt);
        const settled = cron.getJob(job.id)!;
        expect(settled.state.lastRunStatus).toBe("skipped");
        expect(settled.state.nextRunAtMs).toBeGreaterThan(dueAt);
        expect(readCronRunRecordsForTests(job.id)).toHaveLength(1);
        expect(run).toHaveBeenCalledOnce();
        expect(evaluate).toHaveBeenCalledTimes(effect === "trigger" ? 1 : 0);
      } finally {
        cron.stop();
        await cron.waitForIdle();
        await scheduler.stop();
      }
    },
  );
});
