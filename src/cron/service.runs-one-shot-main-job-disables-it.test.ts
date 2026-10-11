import "../test-utils/prepare-compiled-subprocesses.js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { enqueueSessionEventForHost } from "../auto-reply/reply/session-event-handoff.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import * as gatewayWork from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService, type CronEvent } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { cronStoreKey } from "./store/key.js";
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
  const enqueueSessionEvent = vi.fn();
  const runSessionEvent = options.runSessionEvent ?? vi.fn(async () => ({ status: "ok" as const }));
  const deps = {
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent,
    enqueueSessionEvent,
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
  it("records overflowed reminders as failures without losing accepted reminders", async () => {
    const sessionKey = "agent:main:main";
    const enqueueReminder = (text: string, contextKey: string) =>
      enqueueSessionEventForHost(text, {
        agentId: "main",
        sessionKey,
        source: "cron",
        contextKey,
      });
    const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(
      async ({ text, job }) => {
        const outcome = await enqueueReminder(text, `cron:${job.id}`).settled;
        return {
          status: outcome.status === "completed" ? "ok" : "error",
          error: outcome.error,
        };
      },
    );
    const { cron, deps, cleanup } = await fixture({ runSessionEvent });
    const previousConfig = getRuntimeConfigSnapshot();
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    const continuation = vi.spyOn(gatewayWork, "runWithGatewayIndependentRootWorkContinuation");
    resetSystemEventsForTest();
    try {
      const removals = Array.from({ length: 20 }, (_, index) =>
        enqueueSystemEventWithReceipt(`Accepted reminder ${index}`, {
          sessionKey,
          contextKey: `accepted:${index}`,
        }),
      );
      expect(removals.every((remove) => remove !== null)).toBe(true);
      const pending = peekSystemEventEntries(sessionKey);
      const reminders: Array<{ id: string; text: string }> = [];
      for (let index = 0; index < 3; index++) {
        const text = `Reminder ${index}`;
        const job = await cron.add(
          mainJob({
            enabled: false,
            schedule: { kind: "every", everyMs: 3_600_000 },
            payload: { kind: "systemEvent", text },
          }),
        );
        reminders.push({ id: job.id, text });
        await cron.run(job.id, "force");
      }
      expect(peekSystemEventEntries(sessionKey)).toEqual(pending);
      expect(continuation).not.toHaveBeenCalled();
      for (const reminder of reminders) {
        const run = readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(deps.storePath),
          jobId: reminder.id,
        }).entries[0];
        expect(run).toMatchObject({
          status: "error",
          completionStatus: "failed",
          error: expect.stringContaining("queue is full"),
        });
      }
      expect(runSessionEvent).toHaveBeenCalledTimes(3);
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(removals[0]?.()).toBe(true);
      expect(removals[0]?.()).toBe(false);
      const retry = reminders[0]!;
      const receipt = enqueueReminder(retry.text, `cron:${retry.id}`);
      expect(peekSystemEventEntries(sessionKey)).toEqual([
        ...pending.slice(1),
        expect.objectContaining({ id: receipt.id, text: retry.text }),
      ]);
      expect(receipt.cancel()).toBe(true);
      await expect(receipt.settled).resolves.toMatchObject({
        status: "cancelled",
        executionStarted: false,
      });
      for (const remove of removals.slice(1)) {
        expect(remove?.()).toBe(true);
      }
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    } finally {
      resetSystemEventsForTest();
      await Promise.allSettled(
        continuation.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      );
      continuation.mockRestore();
      if (previousConfig) {
        setRuntimeConfigSnapshot(previousConfig);
      } else {
        clearRuntimeConfigSnapshot();
      }
      await cleanup();
    }
  });

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
      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runSessionEvent).toHaveBeenCalledOnce();
      expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
      const { entries } = readCronRunHistoryPageForTests({
        storeKey: cronStoreKey(deps.storePath),
        jobId: job.id,
      });
      expect(entries).toEqual([
        expect.objectContaining({
          status: "error",
          completionStatus: "failed",
          error: expect.stringContaining("session execution failed"),
        }),
      ]);
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
      const { cron, deps, cleanup } = await fixture({ runIsolatedAgentJob });
      try {
        const job = await cron.add(isolatedJob({ delivery: configured, deleteAfterRun: false }));
        const delivery: CronDelivery = {
          mode: "announce",
          target: undefined,
          to: "another-recipient",
          accountId: "other",
          threadId: "other-thread",
          directPolicy: "allow",
        };
        await expect(cron.run(job.id, "force", { delivery })).resolves.toEqual({
          ok: true,
          ran: true,
        });
        expect(runIsolatedAgentJob).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            job: expect.objectContaining({ delivery: expect.objectContaining(expected) }),
          }),
        );
        expect(cron.getJob(job.id)?.delivery).toEqual(configured);
        const { entries } = readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(deps.storePath),
          jobId: job.id,
        });
        expect(entries).toEqual([expect.objectContaining({ status: "ok" })]);
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
          expect(deps.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining('Automation "one-shot" failed 1 times'),
            expect.objectContaining({ contextKey: `cron:${job.id}:failure-alert` }),
          );
        } else {
          expect(stored?.state.nextRunAtMs).toBeTypeOf("number");
          expect(deps.enqueueSystemEvent).not.toHaveBeenCalled();
          expect(deps.enqueueSessionEvent).not.toHaveBeenCalled();
        }
        expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
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
      ).rejects.toThrow(/sessionTarget "main" requires/);
      await expect(cron.add(mainJob({ sessionTarget: "isolated" }))).rejects.toThrow(
        /sessionTarget "isolated" requires/,
      );
    } finally {
      await cleanup();
    }
  });
});
