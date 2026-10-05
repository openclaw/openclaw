// Session-conflict deferral tests cover busy-session cron survival (#165162):
// a claim rejected because a competing writer owns the session is a deferral,
// not an execution failure, so it must not spend the retry budget, and the
// occurrence executes once the writer releases.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { CronService, type CronEvent } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./state.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-session-conflict-",
});
const atMs = Date.parse("2025-12-13T00:00:02.000Z");

const sessionConflictResult = () => ({
  status: "error" as const,
  error: 'Session "agent:main:main" changed while starting work. Retry.',
  admissionDisposition: "session-conflict" as const,
  executionStarted: false as const,
});

const mainJob = (overrides: Partial<CronJobCreate> = {}): CronJobCreate => ({
  name: "session-conflict",
  enabled: true,
  schedule: { kind: "at", at: new Date(atMs).toISOString() },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "do it" },
  delivery: { mode: "announce" },
  ...overrides,
});

async function fixture(options: Partial<Pick<CronServiceDeps, "runIsolatedAgentJob">> = {}) {
  const store = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const finished = createDeferred<CronEvent>();
  const deps: CronServiceDeps = {
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    nowMs: options.nowMs,
    runIsolatedAgentJob: options.runIsolatedAgentJob ?? vi.fn(async () => sessionConflictResult()),
    onEvent: (event: CronEvent) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
  };
  const cron = new CronService(deps);
  await cron.start();
  const cleanup = async () => {
    await cron.status();
    cron.stop();
    await store.cleanup();
    resetSystemEventsForTest();
  };
  return { cron, deps, clock, cleanup };
}

describe("CronService session-conflict deferrals", () => {
  it("defers a one-shot behind an active writer without spending the retry budget", async () => {
    const { cron, deps, clock, cleanup } = await fixture();
    try {
      const job = await cron.add(mainJob());
      expect(job.state.nextRunAtMs).toBe(atMs);
      await clock.advanceTo(atMs);
      await vi.waitFor(() => expect(deps.runIsolatedAgentJob).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeGreaterThan(atMs));

      // The claim was rejected as a deferral: no retry budget spent, the
      // one-shot stays enabled, and the occurrence retries on the conflict
      // backoff instead of disabling.
      const deferredState = cron.getJob(job.id)?.state;
      expect(deferredState?.lastRunStatus).toBe("error");
      expect(deferredState?.consecutiveErrors ?? 0).toBe(0);
      expect(cron.getJob(job.id)?.enabled).toBe(true);

      // Survives past the ordinary transient retry budget (3) while busy.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const nextRunAtMs = cron.getJob(job.id)?.state.nextRunAtMs;
        expect(nextRunAtMs).toBeDefined();
        await clock.advanceTo(nextRunAtMs!);
        await vi.waitFor(() => expect(deps.runIsolatedAgentJob).toHaveBeenCalledTimes(2 + attempt));
        await vi.waitFor(() =>
          expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeGreaterThan(nextRunAtMs!),
        );
      }
      expect(cron.getJob(job.id)?.enabled).toBe(true);
      expect(cron.getJob(job.id)?.state.consecutiveErrors ?? 0).toBe(0);
      expect(deps.runIsolatedAgentJob).toHaveBeenCalledTimes(5);

      // The writer releases: the next attempt claims and executes, and the
      // one-shot success disables the job to prevent a tight loop (#11452).
      deps.runIsolatedAgentJob.mockResolvedValue({ status: "ok" as const });
      const pendingRunAtMs = cron.getJob(job.id)?.state.nextRunAtMs;
      expect(pendingRunAtMs).toBeDefined();
      await clock.advanceTo(pendingRunAtMs!);
      await vi.waitFor(() => {
        const state = cron.getJob(job.id)?.state;
        expect(state?.lastRunStatus ?? state?.lastStatus).toBe("ok");
      });
      expect(cron.getJob(job.id)?.enabled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("does not auto-disable a recurring job across repeated session-conflict deferrals", async () => {
    const { cron, deps, clock, cleanup } = await fixture();
    try {
      const job = await cron.add(
        mainJob({ schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() } }),
      );
      const firstRunAtMs = job.state.nextRunAtMs;
      expect(firstRunAtMs).toBeDefined();
      await clock.advanceTo(firstRunAtMs!);
      // Past the ten-failure auto-disable limit, the deferral streak must not
      // have counted toward it: the job stays enabled with no error streak.
      for (let expectedCalls = 1; expectedCalls <= 12; expectedCalls += 1) {
        await vi.waitFor(() =>
          expect(deps.runIsolatedAgentJob).toHaveBeenCalledTimes(expectedCalls),
        );
        expect(cron.getJob(job.id)?.state.consecutiveErrors ?? 0).toBe(0);
        expect(cron.getJob(job.id)?.enabled).toBe(true);
        await clock.advanceBy(60_000);
      }
      expect(cron.getJob(job.id)?.enabled).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
