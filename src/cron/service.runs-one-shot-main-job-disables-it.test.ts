import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { CronService, type CronEvent } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import type { CronDelivery, CronJobCreate } from "./types.js";

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
  const runSessionEvent = options.runSessionEvent ?? vi.fn(async () => ({ status: "ok" as const }));
  const deps = {
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent,
    runSessionEvent,
    nowMs: options.nowMs,
    runIsolatedAgentJob:
      options.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const })),
    onEvent: (event: CronEvent) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
  };
  const cron = new CronService(deps);
  await cron.start();
  const cleanup = async (service = cron) => {
    await service.status();
    service.stop();
    await store.cleanup();
  };
  return { cron, deps, clock, finished: finished.promise, cleanup };
}

describe("CronService one-shot lifecycle", () => {
  it("disables a retained one-shot after success and does not replay it when re-enabled", async () => {
    const { cron, deps, clock, finished, cleanup } = await fixture();
    try {
      const job = await cron.add(mainJob({ deleteAfterRun: false }));
      expect(job.state.nextRunAtMs).toBe(atMs);
      await clock.advanceTo(atMs);
      await finished;
      expect(cron.getJob(job.id)?.enabled).toBe(false);
      expect(deps.runSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          text: "hello",
          job: expect.objectContaining({ id: job.id, sessionTarget: "main" }),
        }),
      );
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect((await cron.update(job.id, { enabled: true })).state.nextRunAtMs).toBeUndefined();
      await clock.advanceBy(1_000);
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
    const { cron, deps, clock, finished, cleanup } = await fixture({ runIsolatedAgentJob });
    let current = cron;
    try {
      const job = await cron.add(isolatedJob({ delivery: { mode: "announce", bestEffort } }));
      await clock.advanceTo(atMs);
      expect(await finished).toMatchObject({
        status: "ok",
        completionStatus: completion,
        deliveryStatus: unknown ? "unknown" : "not-delivered",
        nextRunAtMs: undefined,
        ...(reason ? { deliverySuppressionReason: reason } : {}),
      });
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(deps.runSessionEvent).not.toHaveBeenCalled();
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
      current = new CronService({
        ...deps,
        scheduler: createTestGatewayScheduler(clock.clock),
        runIsolatedAgentJob: restartedRun,
      });
      await current.start();
      await clock.advanceBy(60_000);
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

  it("reports the exact failed main-session occurrence after durable settlement", async () => {
    const runSessionEvent = vi.fn(async () => {
      throw new Error("session execution failed");
    });
    const { cron, deps, cleanup } = await fixture({ runSessionEvent });
    try {
      const job = await cron.add(
        mainJob({ schedule: { kind: "at", at: new Date(1).toISOString() } }),
      );
      const onSettledResult = vi.fn(() => {
        expect(cron.getJob(job.id)?.state.lastRunStatus).toBe("error");
      });
      await cron.run(job.id, "force", { onSettledResult });
      expect(runSessionEvent).toHaveBeenCalledOnce();
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(onSettledResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          status: "error",
          error: expect.stringContaining("session execution failed"),
        }),
      );
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "error",
        lastError: expect.stringContaining("session execution failed"),
      });
    } finally {
      await cleanup();
    }
  });

  it("disables a skipped one-shot without retrying it", async () => {
    const runSessionEvent = vi.fn(async () => ({ status: "skipped" as const, error: "disabled" }));
    const { cron, deps, cleanup } = await fixture({ runSessionEvent, nowMs: () => atMs });
    try {
      const job = await cron.add(mainJob());
      await cron.run(job.id, "due");
      expect(cron.getJob(job.id)).toMatchObject({
        enabled: false,
        state: { lastStatus: "skipped", lastError: "disabled", consecutiveSkipped: 1 },
      });
      expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeUndefined();
      expect(runSessionEvent).toHaveBeenCalledOnce();
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it.each([
    {
      name: "owner route and account",
      configured: { mode: "announce", target: "owner", accountId: "bound", directPolicy: "block" },
      expected: {
        mode: "announce",
        target: "owner",
        accountId: "bound",
        directPolicy: "block",
        to: undefined,
        threadId: undefined,
      },
    },
    {
      name: "silent policy",
      configured: { mode: "none" },
      expected: {
        mode: "none",
        to: "another-recipient",
        accountId: "other",
        threadId: "other-thread",
      },
    },
  ] satisfies Array<{ name: string; configured: CronDelivery; expected: Partial<CronDelivery> }>)(
    "preserves stored $name during a per-occurrence delivery override",
    async ({ configured, expected }) => {
      const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
        status: "ok",
      }));
      const { cron, cleanup } = await fixture({ runIsolatedAgentJob });
      try {
        const job = await cron.add(isolatedJob({ delivery: configured, deleteAfterRun: false }));
        const onSettledResult = vi.fn();
        await cron.run(job.id, "force", {
          delivery: {
            mode: "announce",
            target: undefined,
            to: "another-recipient",
            accountId: "other",
            threadId: "other-thread",
          },
          onSettledResult,
        });
        expect(runIsolatedAgentJob).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            job: expect.objectContaining({ delivery: expect.objectContaining(expected) }),
          }),
        );
        expect(cron.getJob(job.id)?.delivery).toEqual(configured);
        expect(onSettledResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ status: "ok" }),
        );
      } finally {
        await cleanup();
      }
    },
  );

  it.each([false, true])(
    "retries lifecycle claim conflicts only before execution starts (started=%s)",
    async (executionStarted) => {
      const runIsolatedAgentJob = vi.fn(async () => ({
        status: "error" as const,
        summary: "last output",
        error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
        executionStarted,
      }));
      const { cron, deps, clock, finished, cleanup } = await fixture({ runIsolatedAgentJob });
      try {
        const job = await cron.add(isolatedJob());
        await clock.advanceTo(atMs);
        expect(await finished).toMatchObject({ jobId: job.id, status: "error" });
        const stored = cron.getJob(job.id);
        expect(stored?.enabled).toBe(!executionStarted);
        expect(stored?.state.consecutiveErrors).toBe(1);
        if (executionStarted) {
          expect(stored?.state.nextRunAtMs).toBeUndefined();
        } else {
          expect(stored?.state.nextRunAtMs).toBeTypeOf("number");
        }
        expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
        expect(deps.runSessionEvent).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    },
  );

  it("rejects unsupported session/payload combinations", async () => {
    const { cron, cleanup } = await fixture();
    try {
      await expect(
        cron.add(mainJob({ payload: { kind: "command", argv: ["invalid-main-command"] } })),
      ).rejects.toThrow(/main cron jobs require/);
      await expect(cron.add(mainJob({ sessionTarget: "isolated" }))).rejects.toThrow(
        /isolated.*cron jobs require/,
      );
    } finally {
      await cleanup();
    }
  });
});
