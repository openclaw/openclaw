import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createIsolatedRegressionJob,
  setupCronRegressionFixtures,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import * as schedule from "./schedule.js";
import { onTimer } from "./service/timer.test-support.js";
import { saveCronStore } from "./store.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-66019-" });

async function createErrorCase(expr = "0 0 31 2 *") {
  const { storePath } = fixtures.makeStorePath();
  const scheduledAt = Date.parse("2026-04-13T15:45:00.000Z");
  let now = scheduledAt;
  const job = createIsolatedRegressionJob({
    id: "cron-66019",
    name: "unresolved next run",
    scheduledAt,
    // February 31 has no next occurrence in either scheduling owner.
    schedule: { kind: "cron", expr, tz: "Asia/Shanghai" },
    payload: { kind: "agentTurn", message: "ping" },
    state: { nextRunAtMs: scheduledAt - 1_000 },
  });
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const run = vi.fn().mockResolvedValue({ status: "error", error: "synthetic failure" });
  const state = createCronRegressionState({
    storePath,
    nowMs: () => now,
    runIsolatedAgentJob: run,
  });
  return {
    state,
    run,
    scheduledAt,
    tick: async (at = scheduledAt) => {
      now = at;
      await onTimer(state);
    },
  };
}

describe("#66019 unresolved next-run regression", () => {
  it("does not refire an errored cron after backoff when no next slot exists", async () => {
    const { state, run, scheduledAt, tick } = await createErrorCase();
    try {
      await tick();
      expect(run).toHaveBeenCalledOnce();
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();

      await tick(scheduledAt + 30_001);
      expect(run).toHaveBeenCalledOnce();
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBeUndefined();
    } finally {
      state.timer?.cancel();
      state.timer = null;
    }
  });

  it("preserves error backoff when maintenance later finds a natural next run", async () => {
    const { state, run, scheduledAt, tick } = await createErrorCase("0 7 * * *");
    const naturalNext = scheduledAt + 5_000;
    const backoffNext = scheduledAt + 30_000;
    const nextRunSpy = vi
      .spyOn(schedule, "computeNextRunAtMs")
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(naturalNext);

    try {
      await tick();
      expect(run).toHaveBeenCalledOnce();
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toBe(backoffNext);

      await tick(naturalNext + 1);
      expect(run).toHaveBeenCalledOnce();
      await tick(backoffNext + 1);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      nextRunSpy.mockRestore();
      state.timer?.cancel();
      state.timer = null;
    }
  });
});
