import { expect, it } from "vitest";
import * as clocks from "../test-utils/gateway-scheduler-clock.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import type { CronService } from "./service.js";
import * as serviceTest from "./service.test-harness.js";
import { onTimer } from "./service/timer.test-support.js";
import type { CronJob, CronSchedule } from "./types.js";

const { logger, makeStorePath } = serviceTest.setupCronServiceSuite({ fakeTimers: false });
const base = Date.parse("2025-12-13T00:00:00.000Z");

async function withScheduledJob(
  schedule: CronSchedule,
  exercise: (fixture: {
    cron: CronService;
    job: CronJob;
    clock: ReturnType<typeof clocks.createGatewaySchedulerClock>;
  }) => Promise<void>,
) {
  const { storePath } = await makeStorePath();
  const clock = clocks.createGatewaySchedulerClock(base);
  const finished = serviceTest.createFinishedBarrier();
  const turns: Promise<unknown>[] = [];
  const joinTurns = async () => {
    const failures: unknown[] = [];
    for (const turn of turns) {
      await turn.catch((error: unknown) => failures.push(error));
    }
    expect(failures, "Cron fixture scheduler failed").toEqual([]);
  };
  const { cron, state } = serviceTest.createCronServiceWithStateForTest({
    ...cronTestDeps({ storePath }),
    scheduler: clocks.createTestGatewayScheduler(clock.clock),
    nowMs: () => clock.clock.now(),
    log: logger,
    onEvent: finished.onEvent,
    runSchedulerOwned: (run) => {
      const turn = run();
      turns.push(turn);
      return turn;
    },
  });
  try {
    await cron.start();
    let job = await cron.add(cronTestInput({ schedule }));
    if (schedule.kind === "every") {
      expect(job.schedule).toMatchObject({ anchorMs: base });
      expect(job.state.nextRunAtMs).toBe(base + schedule.everyMs);
      const firstRun = finished.waitForOk(job.id);
      await clock.advanceTo(job.state.nextRunAtMs! + 5);
      await onTimer(state);
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

const every = { kind: "every", everyMs: 10_000 } as const;
it.each<[CronSchedule, number?, number?]>([
  [every],
  [{ kind: "cron", expr: "0 9 * * *" }],
  [every, 3_600_000],
  [every, 3_600_000, 7_200_000],
])("re-saves %j with interval %s and future offset %s", async (schedule, everyMs, futureOffset) => {
  await withScheduledJob(schedule, async ({ cron, job, clock }) => {
    const changing = everyMs !== undefined;
    const dueSlot = job.state.nextRunAtMs!;
    const editTime = changing ? job.state.lastRunAtMs! + 3_000 : dueSlot + 50;
    const anchorMs = futureOffset === undefined ? undefined : editTime + futureOffset;
    clock.setTime(editTime);
    const updatedSchedule: CronSchedule = changing
      ? { kind: "every", everyMs, ...(anchorMs === undefined ? {} : { anchorMs }) }
      : schedule;
    await cron.update(job.id, { schedule: updatedSchedule });
    const current = (await cron.list({ includeDisabled: true })).find(({ id }) => id === job.id)!;
    expect([current.state.lastRunAtMs, current.state.nextRunAtMs]).toEqual([
      job.state.lastRunAtMs,
      changing ? (anchorMs ?? editTime + everyMs) : dueSlot,
    ]);
    if (updatedSchedule.kind === "every") {
      expect(current.schedule).toMatchObject({
        kind: "every",
        everyMs: updatedSchedule.everyMs,
        anchorMs: changing ? (anchorMs ?? editTime) : base,
      });
    }
    if (!changing) {
      expect(current.state.nextRunAtMs).toBeLessThanOrEqual(clock.clock.now());
    }
  });
});
