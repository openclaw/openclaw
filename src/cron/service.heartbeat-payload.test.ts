import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import {
  requestHeartbeatAndWait as requestQueuedHeartbeatAndWait,
  setHeartbeatWakeHandler,
  type HeartbeatWakeHandler,
} from "../infra/heartbeat-wake.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import type { CronEvent } from "./service.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite();
type HeartbeatHarness = ReturnType<typeof createStartedCronServiceWithFinishedBarrier>;
type HeartbeatOptions = Omit<
  Parameters<typeof createStartedCronServiceWithFinishedBarrier>[0],
  "scheduler" | "storePath" | "logger" | "onEvent"
>;

let active: HeartbeatHarness | undefined;
async function startHeartbeatCron(options: HeartbeatOptions = {}) {
  const { storePath } = await makeStorePath();
  const events: CronEvent[] = [];
  const context = createStartedCronServiceWithFinishedBarrier({
    scheduler: createTestGatewayScheduler(),
    storePath,
    logger,
    ...options,
    onEvent: (event) => events.push(structuredClone(event)),
  });
  active = context;
  await context.cron.start();
  return { ...context, events };
}

const monitor = (overrides: Partial<CronJobCreate> = {}): CronJobCreate => ({
  declarationKey: "heartbeat:main",
  name: "heartbeat-main",
  enabled: true,
  schedule: { kind: "every", everyMs: 60_000 },
  payload: { kind: "heartbeat" },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  ...overrides,
});

async function addMonitor(cron: HeartbeatHarness["cron"], everyMs = 60_000) {
  const added = await cron.add(monitor({ agentId: "main", schedule: { kind: "every", everyMs } }), {
    enabledExplicit: true,
    systemOwned: true,
  });
  return "job" in added ? added.job : added;
}

function expectWake(context: HeartbeatHarness, payload: unknown) {
  expect(context.requestHeartbeatAndWait).toHaveBeenCalledWith(
    payload,
    expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
  );
  expect(context.requestHeartbeat).not.toHaveBeenCalled();
  expect(context.enqueueSystemEvent).not.toHaveBeenCalled();
}

describe("heartbeat payload execution", () => {
  afterEach(async () => {
    active?.cron.stop();
    await active?.cron.waitForIdle();
    active = undefined;
  });

  it("fires a system-owned monitor as an interval wake without a system event", async () => {
    const context = await startHeartbeatCron();
    const { cron } = context;
    const job = await addMonitor(cron);
    await expect(cron.update(job.id, { enabled: false })).rejects.toThrow(/system-owned/);
    await expect(cron.remove(job.id)).rejects.toThrow(/system-owned/);
    await expect(
      cron.add(monitor({ name: "rogue-upsert", payload: { kind: "systemEvent", text: "hijack" } })),
    ).rejects.toThrow(/system-owned/);
    await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ok: true });
    expectWake(
      context,
      expect.objectContaining({
        source: "interval",
        intent: "scheduled",
        agentId: "main",
        scheduledEveryMs: 60_000,
      }),
    );
    expect(cron.getJob(job.id)?.state).toMatchObject({
      lastRunStatus: "ok",
      lastStatus: "ok",
      consecutiveErrors: 0,
    });
  });

  it("retains the real queue result after busy waiting exceeds the execution timeout", async () => {
    vi.setSystemTime(new Date("2026-09-15T05:25:39Z"));
    const handler = vi
      .fn<HeartbeatWakeHandler>()
      .mockResolvedValue({ status: "failed", reason: "runner failed after retry" })
      .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" });
    setHeartbeatWakeHandler(handler);
    try {
      const { cron, events } = await startHeartbeatCron({
        requestHeartbeatAndWait: (wake, lifecycle) =>
          requestQueuedHeartbeatAndWait({ ...wake, coalesceMs: 0 }, lifecycle),
        resolveHeartbeatTimeoutMs: () => 100,
      });
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
    } finally {
      setHeartbeatWakeHandler(null);
    }
  });

  it("settles an enqueued manual heartbeat run without occupying the command lane", async () => {
    const { cron, finished } = await startHeartbeatCron();
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
  });

  it("times out an unsettled heartbeat wake without authoring success", async () => {
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const { cron, requestHeartbeatAndWait, events } = await startHeartbeatCron({
      requestHeartbeatAndWait: async (_request, lifecycle) => {
        expect(lifecycle.abortSignal).toBeInstanceOf(AbortSignal);
        await waitForAbortSignal(lifecycle.abortSignal);
        return { status: "failed", reason: "heartbeat wake cancelled" };
      },
    });
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
  });

  it("routes migrated task jobs through the guarded task wake path", async () => {
    const context = await startHeartbeatCron();
    const { cron } = context;
    const input = monitor({
      declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
      agentId: "main",
      name: "inbox",
      payload: { kind: "systemEvent", text: "Check urgent inbox items" },
    });
    await expect(cron.add(input)).rejects.toThrow(/system-owned/);
    const added = await cron.add(input, { systemOwned: true });
    const job = "job" in added ? added.job : added;
    await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ok: true });
    expectWake(context, {
      source: "interval",
      intent: "task",
      reason: `heartbeat-task:${job.id}`,
      agentId: "main",
      tasks: [{ jobId: job.id, name: "inbox", prompt: "Check urgent inbox items" }],
    });
    await expect(
      cron.update(job.id, { payload: { kind: "systemEvent", text: "Check priority inbox" } }),
    ).resolves.toMatchObject({ id: job.id });
    await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });
  });
});
