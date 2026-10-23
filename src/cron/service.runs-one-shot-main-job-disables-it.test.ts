import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import type { CronEvent } from "./service.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-one-shot-" });
const atMs = Date.parse("2025-12-13T00:00:02.000Z");
const mainJob = (overrides: Partial<CronJobCreate> = {}): CronJobCreate => ({
  name: "one-shot",
  enabled: true,
  schedule: { kind: "at", at: new Date(atMs).toISOString() },
  sessionTarget: "main",
  wakeMode: "now",
  payload: { kind: "systemEvent", text: "hello" },
  ...overrides,
});
const isolatedJob = (overrides: Partial<CronJobCreate> = {}): CronJobCreate =>
  mainJob({
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "do it" },
    delivery: { mode: "announce" },
    ...overrides,
  });

async function fixture(
  options: Partial<Pick<CronServiceDeps, "runIsolatedAgentJob" | "runSessionEvent" | "nowMs">> = {},
) {
  const store = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const finished = createDeferred<CronEvent>();
  const enqueueSystemEvent = vi.fn();
  const enqueueSessionEvent = vi.fn();
  const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(
    options.runSessionEvent ?? (async () => ({ status: "ok" })),
  );
  const deps = {
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent,
    nowMs: options.nowMs,
    runSessionEvent,
    enqueueSessionEvent,
    runIsolatedAgentJob:
      options.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const })),
    onEvent: (event: CronEvent) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
  };
  const { cron, state } = createCronServiceWithStateForTest(deps);
  await cron.start();
  const cleanup = async (service = cron) => {
    await service.status();
    service.stop();
    await service.waitForIdle();
    await store.cleanup();
  };
  return { cron, state, deps, clock, finished: finished.promise, cleanup };
}

describe("CronService one-shot lifecycle", () => {
  it("disables a retained one-shot after success and does not replay it when re-enabled", async () => {
    const { cron, state, deps, clock, finished, cleanup } = await fixture();
    try {
      const job = await cron.add(mainJob({ deleteAfterRun: false }));
      expect(job.state.nextRunAtMs).toBe(atMs);
      clock.setTime(atMs);
      await onTimer(state);
      await finished;
      expect(cron.getJob(job.id)?.enabled).toBe(false);
      expect(deps.runSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ job: expect.objectContaining({ id: job.id }), text: "hello" }),
      );
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect((await cron.update(job.id, { enabled: true })).state.nextRunAtMs).toBeUndefined();
      clock.setTime(clock.clock.now() + 1_000);
      await onTimer(state);
      expect(deps.runSessionEvent).toHaveBeenCalledOnce();
    } finally {
      await cleanup();
    }
  });

  it.each([
    {
      name: "default delivery failure",
      bestEffort: undefined,
      unknown: false,
      reason: undefined,
      completion: "failed",
    },
    {
      name: "best-effort delivery failure",
      bestEffort: true,
      unknown: false,
      reason: undefined,
      completion: "succeeded",
    },
    {
      name: "unknown delivery",
      bestEffort: undefined,
      unknown: true,
      reason: undefined,
      completion: "unknown",
    },
    {
      name: "silent suppression",
      bestEffort: false,
      unknown: false,
      reason: "silent" as const,
      completion: "succeeded",
    },
  ])("cleans up $name once across restart", async ({ bestEffort, unknown, reason, completion }) => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "payload completed",
      delivered: unknown ? undefined : false,
      deliveryError: unknown || reason ? undefined : "delivery rejected",
      deliverySuppressionReason: reason,
    }));
    const { cron, state, deps, clock, finished, cleanup } = await fixture({ runIsolatedAgentJob });
    let current = cron;
    try {
      const job = await cron.add(isolatedJob({ delivery: { mode: "announce", bestEffort } }));
      clock.setTime(atMs);
      await onTimer(state);
      expect(await finished).toMatchObject({
        status: "ok",
        completionStatus: completion,
        deliveryStatus: unknown ? "unknown" : "not-delivered",
        nextRunAtMs: undefined,
        ...(reason ? { deliverySuppressionReason: reason } : {}),
      });
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      const retained = cron.getJob(job.id);
      if (completion === "succeeded") {
        expect(retained).toBeUndefined();
      } else {
        expect(retained).toMatchObject({
          enabled: false,
          state: { lastRunStatus: "ok", consecutiveErrors: 0 },
        });
      }
      expect(retained?.state.nextRunAtMs).toBeUndefined();
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      cron.stop();
      const restartedRun = vi.fn(async () => ({ status: "ok" as const }));
      const restarted = createCronServiceWithStateForTest({
        ...deps,
        scheduler: createTestGatewayScheduler(clock.clock),
        runIsolatedAgentJob: restartedRun,
      });
      current = restarted.cron;
      await current.start();
      clock.setTime(clock.clock.now() + 60_000);
      await onTimer(restarted.state);
      expect(restartedRun).not.toHaveBeenCalled();
      if (completion === "succeeded") {
        expect(current.getJob(job.id)).toBeUndefined();
      } else {
        expect(current.getJob(job.id)).toMatchObject({ enabled: false });
      }
    } finally {
      await cleanup(current);
    }
  });

  it("records a refused main-session event as one failure without enqueuing a replay", async () => {
    const runSessionEvent = vi.fn(async () => ({
      status: "error" as const,
      error: "session admission refused",
      executionStarted: false,
    }));
    const { cron, deps, cleanup } = await fixture({ runSessionEvent });
    try {
      const job = await cron.add(
        mainJob({ schedule: { kind: "at", at: new Date(1).toISOString() } }),
      );
      await cron.run(job.id, "force");
      expect(runSessionEvent).toHaveBeenCalledOnce();
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(deps.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("auto-disabled"),
        expect.objectContaining({ contextKey: `cron:${job.id}:auto-disabled` }),
      );
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "error",
        lastError: "session admission refused",
        autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 1 },
      });
      expect(
        readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(deps.storePath),
          jobId: job.id,
        }).entries,
      ).toMatchObject([{ status: "error", completionStatus: "failed" }]);
    } finally {
      await cleanup();
    }
  });

  it("consumes a scratch-empty one-shot without replaying it after restart", async () => {
    let now = atMs;
    const { cron, deps, cleanup } = await fixture({ nowMs: () => now });
    let current = cron;
    try {
      const job = await cron.add(
        mainJob({
          payload: { kind: "agentTurn", message: "Check the scratch", skipIfScratchEmpty: true },
        }),
      );
      await cron.writeScratch(job.id, { content: "" });
      await cron.run(job.id, "due");
      expect(cron.getJob(job.id)).toMatchObject({
        enabled: false,
        state: {
          lastStatus: "skipped",
          lastError: undefined,
          consecutiveSkipped: 1,
          nextRunAtMs: undefined,
        },
      });
      cron.stop();
      await cron.waitForIdle();
      now += 90_000;
      const restarted = createCronServiceWithStateForTest({
        ...deps,
        scheduler: createTestGatewayScheduler(),
      });
      current = restarted.cron;
      await current.start();
      await current.writeScratch(job.id, { content: "Check the newly populated scratch" });
      await onTimer(restarted.state);
      expect(deps.runSessionEvent).not.toHaveBeenCalled();
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(
        readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(deps.storePath),
          jobId: job.id,
        }).entries,
      ).toMatchObject([{ status: "skipped", summary: "Automation scratch is explicitly empty" }]);
    } finally {
      await cleanup(current);
    }
  });

  it.each([false, true])(
    "retries lifecycle claim conflicts only before execution starts (started=%s)",
    async (executionStarted) => {
      const runIsolatedAgentJob = vi.fn(async () => ({
        status: "error" as const,
        summary: "last output",
        error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
        executionStarted,
      }));
      const { cron, state, deps, clock, finished, cleanup } = await fixture({
        runIsolatedAgentJob,
      });
      try {
        const job = await cron.add(isolatedJob());
        clock.setTime(atMs);
        await onTimer(state);
        expect(await finished).toMatchObject({ jobId: job.id, status: "error" });
        const stored = cron.getJob(job.id);
        expect(stored?.enabled).toBe(!executionStarted);
        expect(stored?.state.consecutiveErrors).toBe(1);
        if (executionStarted) {
          expect(stored?.state.autoDisabled).toMatchObject({
            reason: "consecutive-failures",
            consecutiveErrors: 1,
          });
          expect(stored?.state.nextRunAtMs).toBeUndefined();
          expect(deps.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining('Automation "one-shot" failed 1 times'),
            expect.objectContaining({ contextKey: `cron:${job.id}:failure-alert` }),
          );
        } else {
          expect(stored?.state.nextRunAtMs).toBeTypeOf("number");
          expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
        }
        expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      } finally {
        await cleanup();
      }
    },
  );

  it("rejects unsupported session/payload combinations", async () => {
    const { cron, cleanup } = await fixture();
    try {
      await expect(cron.add(mainJob({ sessionTarget: "isolated" }))).rejects.toThrow(
        /sessionTarget "isolated" requires/,
      );
    } finally {
      await cleanup();
    }
  });
});
