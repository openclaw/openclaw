import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import {
  drainSystemEventEntries,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { CronService, type CronEvent } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
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

function sessionKey(target?: { agentId?: string; sessionKey?: string }) {
  return (
    target?.sessionKey ??
    resolveAgentMainSessionKey({ cfg: {}, agentId: target?.agentId ?? "main" })
  );
}

async function fixture(
  options: Partial<
    Pick<CronServiceDeps, "runIsolatedAgentJob" | "requestHeartbeatAndWait" | "nowMs">
  > & { removable?: boolean } = {},
) {
  const store = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const finished = createDeferred<CronEvent>();
  const enqueueSystemEvent = options.removable
    ? vi.fn((text: string, opts?: Parameters<CronServiceDeps["enqueueSystemEvent"]>[1]) => {
        const remove = enqueueSystemEventWithReceipt(text, {
          sessionKey: sessionKey(opts),
          contextKey: opts?.contextKey,
          deliveryContext: opts?.deliveryContext,
        });
        return remove ? { accepted: true, remove } : { accepted: false };
      })
    : vi.fn();
  const requestHeartbeat = vi.fn();
  const deps = {
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent,
    requestHeartbeat,
    nowMs: options.nowMs,
    requestHeartbeatAndWait: options.requestHeartbeatAndWait,
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
    resetSystemEventsForTest();
  };
  const expectEmptyQueue = () => {
    for (const [, target] of enqueueSystemEvent.mock.calls) {
      expect(peekSystemEventEntries(sessionKey(target))).toHaveLength(0);
    }
  };
  return { cron, deps, clock, finished: finished.promise, cleanup, expectEmptyQueue };
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
      expect(deps.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("hello", {
        agentId: "main",
        contextKey: `cron:${job.id}`,
      });
      expect(deps.requestHeartbeat).toHaveBeenCalled();
      expect((await cron.update(job.id, { enabled: true })).state.nextRunAtMs).toBeUndefined();
      await clock.advanceBy(1_000);
      expect(deps.enqueueSystemEvent).toHaveBeenCalledOnce();
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
        ...(reason ? { deliverySuppressionReason: reason } : {}),
      });
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(deps.requestHeartbeat).not.toHaveBeenCalled();
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

  it("removes a queued main-session event when an immediate heartbeat fails", async () => {
    const requestHeartbeatAndWait = vi.fn(async () => {
      throw new Error("heartbeat failed");
    });
    const { cron, deps, cleanup, expectEmptyQueue } = await fixture({
      requestHeartbeatAndWait,
      removable: true,
    });
    try {
      const job = await cron.add(
        mainJob({ schedule: { kind: "at", at: new Date(1).toISOString() } }),
      );
      await cron.run(job.id, "force");
      expect(requestHeartbeatAndWait).toHaveBeenCalledOnce();
      expect(deps.requestHeartbeat).not.toHaveBeenCalled();
      expect(deps.enqueueSystemEvent).toHaveBeenCalledOnce();
      expectEmptyQueue();
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "error",
        lastError: expect.stringContaining("heartbeat failed"),
      });
    } finally {
      await cleanup();
    }
  });

  it("retries disabled one-shot main wakes without leaving failed-attempt system events", async () => {
    resetSystemEventsForTest();
    let now = atMs;
    const consumedTexts: string[] = [];
    const requestHeartbeatAndWait = vi.fn(
      async (opts?: Parameters<NonNullable<CronServiceDeps["requestHeartbeatAndWait"]>>[0]) => {
        if (requestHeartbeatAndWait.mock.calls.length < 3) {
          return { status: "skipped" as const, reason: "disabled" };
        }
        consumedTexts.push(...drainSystemEventEntries(sessionKey(opts)).map((event) => event.text));
        return { status: "ran" as const, durationMs: 1 };
      },
    );
    const { cron, deps, cleanup, expectEmptyQueue } = await fixture({
      requestHeartbeatAndWait,
      nowMs: () => now,
      removable: true,
    });
    try {
      const job = await cron.add(mainJob());
      for (const [attempt, delay] of [
        [1, 30_000],
        [2, 90_000],
      ] as const) {
        await cron.run(job.id, "due");
        const stored = cron.getJob(job.id);
        expect(stored).toMatchObject({
          enabled: true,
          state: {
            lastStatus: "skipped",
            lastError: "disabled",
            consecutiveSkipped: attempt,
            nextRunAtMs: atMs + delay,
          },
        });
        expectEmptyQueue();
        now = atMs + delay;
      }
      await cron.run(job.id, "due");
      expect(cron.getJob(job.id)).toBeUndefined();
      expect(requestHeartbeatAndWait).toHaveBeenCalledTimes(3);
      expect(deps.requestHeartbeat).not.toHaveBeenCalled();
      expect(consumedTexts).toEqual(["hello"]);
      expectEmptyQueue();
    } finally {
      await cleanup();
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
        expect(deps.requestHeartbeat).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    },
  );

  it("rejects unsupported session/payload combinations", async () => {
    const { cron, cleanup } = await fixture();
    try {
      await expect(
        cron.add(mainJob({ payload: { kind: "agentTurn", message: "nope" } })),
      ).rejects.toThrow(/main cron jobs require/);
      await expect(cron.add(mainJob({ sessionTarget: "isolated" }))).rejects.toThrow(
        /isolated.*cron jobs require/,
      );
    } finally {
      await cleanup();
    }
  });
});
