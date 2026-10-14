import { describe, expect, it, vi } from "vitest";
import {
  requestHeartbeatAndWait as requestQueuedHeartbeatAndWait,
  setHeartbeatWakeHandler,
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
} from "../infra/heartbeat-wake.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { listCronHeartbeatWaitOwners } from "./active-jobs.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import type { CronEvent } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
} from "./service.test-harness.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger });
type HeartbeatHarness = ReturnType<typeof createStartedCronServiceWithFinishedBarrier>;
type HeartbeatOptions = Omit<
  Parameters<typeof createStartedCronServiceWithFinishedBarrier>[0],
  "scheduler" | "storePath" | "logger" | "onEvent"
>;

async function withHeartbeatCron(
  options: HeartbeatOptions,
  run: (context: HeartbeatHarness & { events: CronEvent[] }) => Promise<void>,
) {
  const { storePath, cleanup } = await makeStorePath();
  const events: CronEvent[] = [];
  const context = createStartedCronServiceWithFinishedBarrier({
    scheduler: createTestGatewayScheduler(),
    storePath,
    logger,
    ...options,
    onEvent: (event) => events.push(structuredClone(event)),
  });
  try {
    await context.cron.start();
    await run({ ...context, events });
  } finally {
    context.cron.stop();
    await context.cron.waitForIdle();
    await cleanup();
  }
}

async function addMonitor(cron: HeartbeatHarness["cron"], everyMs = 60_000) {
  const added = await cron.add(
    {
      declarationKey: "heartbeat:main",
      name: "heartbeat-main",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every", everyMs },
      payload: { kind: "heartbeat" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    },
    { enabledExplicit: true, systemOwned: true },
  );
  return "job" in added ? added.job : added;
}

describe("heartbeat payload execution", () => {
  it("fires a system-owned monitor as an interval wake without a system event", async () => {
    await withHeartbeatCron(
      {},
      async ({ cron, enqueueSystemEvent, requestHeartbeat, requestHeartbeatAndWait }) => {
        const job = await addMonitor(cron);
        await expect(cron.update(job.id, { enabled: false })).rejects.toThrow(/system-owned/);
        await expect(cron.remove(job.id)).rejects.toThrow(/system-owned/);
        await expect(
          cron.add({
            declarationKey: "heartbeat:main",
            name: "rogue-upsert",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            payload: { kind: "systemEvent", text: "hijack" },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
          }),
        ).rejects.toThrow(/system-owned/);
        await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ok: true });
        expect(requestHeartbeatAndWait).toHaveBeenCalledWith(
          expect.objectContaining({
            source: "interval",
            intent: "scheduled",
            agentId: "main",
            scheduledEveryMs: 60_000,
          }),
          expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
        );
        expect(requestHeartbeat).not.toHaveBeenCalled();
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: "ok",
          lastStatus: "ok",
          consecutiveErrors: 0,
        });
      },
    );
  });

  it("retains the real queue result after busy waiting exceeds the execution timeout", async () => {
    vi.setSystemTime(new Date("2026-09-15T05:25:39Z"));
    const handler = vi
      .fn<HeartbeatWakeHandler>()
      .mockResolvedValue({ status: "failed", reason: "runner failed after retry" })
      .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" });
    setHeartbeatWakeHandler(handler);
    try {
      await withHeartbeatCron(
        {
          requestHeartbeatAndWait: (wake, lifecycle) =>
            requestQueuedHeartbeatAndWait({ ...wake, coalesceMs: 0 }, lifecycle),
          resolveHeartbeatTimeoutMs: () => 100,
        },
        async ({ cron, events }) => {
          const job = await addMonitor(cron);
          const runPromise = cron.run(job.id, "force");
          await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
          await vi.advanceTimersByTimeAsync(30_000);
          expect(events.some((event) => event.action === "finished")).toBe(false);
          expect(cron.getJob(job.id)?.state.consecutiveErrors ?? 0).toBe(0);
          await vi.advanceTimersByTimeAsync(30_000);
          await expect(runPromise).resolves.toMatchObject({ ok: true, ran: true });
          expect(handler).toHaveBeenCalledTimes(2);
          expect(cron.getJob(job.id)?.state).toMatchObject({
            lastRunStatus: "error",
            lastStatus: "error",
            lastError: "heartbeat failed: runner failed after retry",
            consecutiveErrors: 1,
          });
          expect(events.findLast((event) => event.action === "finished")).toMatchObject({
            status: "error",
            completionStatus: "failed",
            error: "heartbeat failed: runner failed after retry",
          });
        },
      );
    } finally {
      setHeartbeatWakeHandler(null);
    }
  });

  it("settles an enqueued manual heartbeat run without occupying the command lane", async () => {
    let observedWaitOwners: ReturnType<typeof listCronHeartbeatWaitOwners> | undefined;
    await withHeartbeatCron(
      {
        requestHeartbeatAndWait: async () => {
          observedWaitOwners = listCronHeartbeatWaitOwners();
          return { status: "ran", durationMs: 1 };
        },
      },
      async ({ cron, finished }) => {
        const job = await addMonitor(cron);
        const terminal = finished.waitForOk(job.id);
        await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
          ok: true,
          enqueued: true,
        });
        await expect(terminal).resolves.toMatchObject({
          status: "ok",
          completionStatus: "succeeded",
        });
        expect(observedWaitOwners).toEqual([expect.objectContaining({ jobId: job.id })]);
      },
    );
  });

  it("times out an unsettled heartbeat wake without authoring success", async () => {
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    await withHeartbeatCron(
      {
        requestHeartbeatAndWait: async (_request, lifecycle) =>
          await new Promise<HeartbeatRunResult>((resolve) => {
            const onAbort = () => resolve({ status: "failed", reason: "heartbeat wake cancelled" });
            if (lifecycle.abortSignal?.aborted) {
              onAbort();
            } else {
              lifecycle.abortSignal?.addEventListener("abort", onAbort, { once: true });
            }
          }),
      },
      async ({ cron, requestHeartbeatAndWait, events }) => {
        const job = await addMonitor(cron, 60 * 60_000);
        const runPromise = cron.run(job.id, "force");
        await vi.waitFor(() => expect(requestHeartbeatAndWait).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await expect(runPromise).resolves.toMatchObject({ ok: true, ran: true });
        expect(events.findLast((event) => event.action === "finished")).toMatchObject({
          status: "error",
          completionStatus: "failed",
          error: expect.stringContaining("job execution timed out"),
        });
      },
    );
  });

  it("routes migrated task jobs through the guarded task wake path", async () => {
    await withHeartbeatCron(
      {},
      async ({ cron, enqueueSystemEvent, requestHeartbeat, requestHeartbeatAndWait }) => {
        const declarationKey = heartbeatTaskDeclarationKey("main", "inbox");
        const input = {
          declarationKey,
          name: "inbox",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "systemEvent", text: "Check urgent inbox items" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        } as const;
        await expect(cron.add(input)).rejects.toThrow(/system-owned/);
        const added = await cron.add(input, { systemOwned: true });
        const job = "job" in added ? added.job : added;
        await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ok: true });
        expect(requestHeartbeatAndWait).toHaveBeenCalledWith(
          {
            source: "interval",
            intent: "task",
            reason: `heartbeat-task:${job.id}`,
            agentId: "main",
            tasks: [{ jobId: job.id, name: "inbox", prompt: "Check urgent inbox items" }],
          },
          expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
        );
        expect(requestHeartbeat).not.toHaveBeenCalled();
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        await expect(
          cron.update(job.id, { payload: { kind: "systemEvent", text: "Check priority inbox" } }),
        ).resolves.toMatchObject({ id: job.id });
        await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });
      },
    );
  });
});
