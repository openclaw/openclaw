import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  readCronRunRecordsForTests,
  readCronRunHistoryPageForTests,
} from "./run-history.test-support.js";
import { CronService, type CronEvent } from "./service.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { MIN_REFIRE_GAP_MS } from "./service/timer-execution-timeout.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";
import type { CronJobExecutionResult, CronRunOutcome } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-session-payload-",
  fakeTimers: false,
});

describe("ordinary session agent turns", () => {
  it.each(
    (["ok", "error"] as const).flatMap((status) =>
      (["main", "session:agent:main:project:inbox"] as const).map((sessionTarget) => ({
        status,
        sessionTarget,
      })),
    ),
  )(
    "keeps the durable run pending until $sessionTarget settles with $status",
    async ({ status, sessionTarget }) => {
      const { storePath } = await makeStorePath();
      const entered = createDeferred();
      const settlement = createDeferred<CronRunOutcome>();
      const events: CronEvent[] = [];
      const runSessionEvent = vi.fn(async () => {
        entered.resolve();
        return settlement.promise;
      });
      const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
        status: "ok",
      }));
      const deps = {
        storePath,
        scheduler: createTestGatewayScheduler(),
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob,
        runSessionEvent,
        onEvent: (event: CronEvent) => events.push(event),
      };
      const cron = new CronService(deps);
      let running: ReturnType<CronService["run"]> | undefined;
      try {
        await cron.start();
        const job = await cron.add({
          name: "Check the project inbox",
          agentId: "main",
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "agentTurn", message: "Check urgent project items" },
          sessionTarget,
          wakeMode: "now",
          delivery: { mode: "none" },
        });
        const history = () =>
          readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
            .entries;
        running = cron.run(job.id, "force");
        await awaitGateBeforeSettlement(
          entered.promise,
          running,
          "Scheduled session run finished without entering runSessionEvent",
        );
        expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            job: expect.objectContaining({ id: job.id }),
            text: "Check urgent project items",
            abortSignal: expect.any(AbortSignal),
          }),
        );
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(
          (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)?.state,
        ).toMatchObject({
          runningAtMs: expect.any(Number),
          runningReceiptId: expect.any(String),
        });
        expect(history()).toEqual([]);
        expect(events.filter((event) => event.action === "finished")).toEqual([]);

        settlement.resolve({
          status,
          ...(status === "error" ? { error: "provider unavailable" } : {}),
        });
        await expect(running).resolves.toMatchObject({ ok: true, ran: true });
        expect(history()).toMatchObject([{ status }]);
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
      } finally {
        settlement.resolve({ status: "error", error: "fixture cleanup" });
        await running;
        cron.stop();
        await cron.waitForIdle();
      }
    },
  );
});

describe("unstarted scheduled admission", () => {
  it.each(["at", "every", "cron"] as const)(
    "retains only one-shot occurrences outside active hours (%s)",
    async (scheduleKind) => {
      const store = await makeStorePath();
      const clock = createGatewaySchedulerClock(Date.parse("2026-10-20T08:59:00Z"));
      const scheduler = createTestGatewayScheduler(clock.clock);
      const run = vi.fn(async (): Promise<CronJobExecutionResult> => ({
        status: "ok",
        executionStarted: true,
      }));
      const events: CronEvent[] = [];
      const { cron, state } = createCronServiceWithStateForTest({
        scheduler,
        storePath: store.storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        enqueueSystemEvent: vi.fn(),
        runSessionEvent: run,
        runIsolatedAgentJob: run,
        onEvent: (event) => events.push(event),
      });
      try {
        const job = await cron.add({
          name: `Active hours ${scheduleKind}`,
          enabled: true,
          deleteAfterRun: false,
          schedule:
            scheduleKind === "at"
              ? { kind: "at", at: "2026-10-20T09:00:00Z" }
              : scheduleKind === "every"
                ? { kind: "every", everyMs: 60_000 }
                : { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 },
          activeHours: { start: "10:00", end: "17:00", timezone: "UTC" },
          payload: { kind: "agentTurn", message: "Run inside active hours" },
          sessionTarget: "main",
          wakeMode: "now",
          delivery: { mode: "none" },
        });
        await cron.start();
        const dueAt = cron.getJob(job.id)!.state.nextRunAtMs!;
        clock.setTime(dueAt);
        await onTimer(state);
        const waiting = (await loadCronStore(store.storePath)).jobs.find(
          (entry) => entry.id === job.id,
        )!;
        expect(run).not.toHaveBeenCalled();
        expect(waiting.enabled).toBe(true);
        if (scheduleKind === "at") {
          expect(waiting.state.nextRunAtMs).toBe(dueAt);
          expect(waiting.state.lastRunStatus).toBeUndefined();
          expect(readCronRunRecordsForTests(job.id)).toEqual([]);
          expect(events.filter((event) => event.action === "finished")).toEqual([]);
        } else {
          expect(waiting.state.nextRunAtMs).toBeGreaterThan(dueAt);
          expect(waiting.state.lastRunStatus).toBe("skipped");
          expect(readCronRunRecordsForTests(job.id)).toHaveLength(1);
        }
        expect(waiting.state.runningReceiptId).toBeUndefined();
        expect(
          inspectActiveCronRunReceipt({ storePath: store.storePath, jobId: job.id }),
        ).toBeUndefined();

        clock.setTime(Date.parse("2026-10-20T10:00:00Z"));
        await onTimer(state);
        expect(run).toHaveBeenCalledOnce();
        expect(cron.getJob(job.id)!.state.lastRunStatus).toBe("ok");
        expect(readCronRunRecordsForTests(job.id)).toHaveLength(scheduleKind === "at" ? 1 : 2);
        if (scheduleKind === "at") {
          expect(cron.getJob(job.id)!.enabled).toBe(false);
          expect(cron.getJob(job.id)!.state.nextRunAtMs).toBeUndefined();
        }
        clock.setTime(scheduler.now() + MIN_REFIRE_GAP_MS);
        await onTimer(state);
        expect(run).toHaveBeenCalledOnce();
      } finally {
        cron.stop();
        await cron.waitForIdle();
        await scheduler.stop();
      }
    },
  );

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
      const { cron, state } = createCronServiceWithStateForTest({
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
        clock.setTime(dueAt);
        await onTimer(state);
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
        expect((await cron.status()).nextWakeAtMs).toBe(dueAt);
        clock.setTime(scheduler.now() + MIN_REFIRE_GAP_MS);
        await onTimer(state);
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
      const { cron, state } = createCronServiceWithStateForTest({
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
        clock.setTime(dueAt);
        await onTimer(state);
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
