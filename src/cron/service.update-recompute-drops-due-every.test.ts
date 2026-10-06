import { describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { createFinishedBarrier, setupCronServiceSuite } from "./service.test-harness.js";
import type { CronJob, CronSchedule } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ fakeTimers: false });
const base = Date.parse("2025-12-13T00:00:00.000Z");

async function withScheduledJob(
  schedule: CronSchedule,
  exercise: (fixture: {
    cron: CronService;
    job: CronJob;
    clock: ReturnType<typeof createGatewaySchedulerClock>;
  }) => Promise<void>,
) {
  const { storePath } = await makeStorePath();
  const clock = createGatewaySchedulerClock(base);
  const finished = createFinishedBarrier();
  const turns: Promise<unknown>[] = [];
  const joinTurns = async () => {
    const failures: unknown[] = [];
    for (const turn of turns) {
      try {
        await turn;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Cron fixture scheduler failed");
    }
  };
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent: finished.onEvent,
    runSchedulerOwned: (run) => {
      const turn = run();
      turns.push(turn);
      return turn;
    },
  });
  try {
    await cron.start();
    let job = await cron.add({
      name: "scheduled job",
      enabled: true,
      schedule,
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "tick" },
    });
    if (schedule.kind === "every") {
      expect(job.schedule).toMatchObject({ anchorMs: base });
      expect(job.state.nextRunAtMs).toBe(base + schedule.everyMs);
      const firstRun = finished.waitForOk(job.id);
      await clock.advanceTo(job.state.nextRunAtMs! + 5);
      await firstRun;
      // Finished precedes maintenance and timer re-arming.
      await joinTurns();
      job = cron.getJob(job.id)!;
      expect(job.state.nextRunAtMs).toBe(job.state.lastRunAtMs! + schedule.everyMs);
    }
    await exercise({ cron, job, clock });
  } finally {
    cron.stop();
    await joinTurns();
  }
}

describe("recurring schedule edits", () => {
  it.each([
    { kind: "every", everyMs: 10_000 },
    { kind: "cron", expr: "0 9 * * *" },
  ] as const)("preserves a due $kind slot on an idempotent re-save", async (schedule) => {
    await withScheduledJob(schedule, async ({ cron, job, clock }) => {
      const dueSlot = job.state.nextRunAtMs!;
      clock.setTime(dueSlot + 50);
      await cron.update(job.id, { schedule });
      const current = (await cron.list({ includeDisabled: true })).find(
        (entry) => entry.id === job.id,
      )!;
      expect(current.state.lastRunAtMs).toBe(job.state.lastRunAtMs);
      expect(current.state.nextRunAtMs).toBe(dueSlot);
      expect(current.state.nextRunAtMs).toBeLessThanOrEqual(clock.clock.now());
      if (schedule.kind === "every") {
        expect(current.schedule).toMatchObject({ kind: "every", anchorMs: base });
      }
    });
  });

  it.each([undefined, 7_200_000])(
    "re-anchors a changed interval with future offset %s",
    async (futureOffset) => {
      await withScheduledJob({ kind: "every", everyMs: 10_000 }, async ({ cron, job, clock }) => {
        const editTime = job.state.lastRunAtMs! + 3_000;
        clock.setTime(editTime);
        const anchorMs = futureOffset === undefined ? undefined : editTime + futureOffset;
        await cron.update(job.id, {
          schedule: {
            kind: "every",
            everyMs: 3_600_000,
            ...(anchorMs === undefined ? {} : { anchorMs }),
          },
        });
        const current = (await cron.list({ includeDisabled: true })).find(
          (entry) => entry.id === job.id,
        )!;
        expect(current.schedule).toMatchObject({
          kind: "every",
          everyMs: 3_600_000,
          anchorMs: anchorMs ?? editTime,
        });
        expect(current.state.nextRunAtMs).toBe(anchorMs ?? editTime + 3_600_000);
      });
    },
  );
});
