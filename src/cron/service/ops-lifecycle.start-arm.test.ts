import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { start } from "./ops-lifecycle.js";
import { onTimer } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-start-arm-" });

function createDueMainJob(id: string, nowMs: number, nextRunAtMs: number): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "at", at: new Date(nextRunAtMs).toISOString() },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: id },
    delivery: { mode: "none" },
    state: { nextRunAtMs },
  };
}

function installOneShotTerminalWriteFailure(jobId: string) {
  const database = openOpenClawStateDatabase().db;
  let rejected = false;
  database.function("reject_start_arm_terminal", (id: unknown, stateJson: unknown) => {
    if (id === jobId && typeof stateJson === "string") {
      const persisted = JSON.parse(stateJson) as CronJob["state"];
      if (!rejected && persisted.lastRunStatus !== undefined) {
        rejected = true;
        throw new Error("startup terminal write failed");
      }
    }
    return 0;
  });
  database.exec(`
    CREATE TEMP TRIGGER reject_start_arm_terminal
    AFTER UPDATE ON cron_jobs
    BEGIN
      SELECT reject_start_arm_terminal(NEW.job_id, NEW.state_json);
    END;
  `);
  return () => database.exec("DROP TRIGGER IF EXISTS reject_start_arm_terminal");
}

function createStartArmState(storePath: string, nowMs: number) {
  return createCronRegressionState({
    storePath,
    nowMs: () => nowMs,
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    maxMissedJobsPerRestart: 40,
  });
}

it("arms the scheduler and still rejects when startup catch-up fails", async () => {
  const store = fixtures.makeStorePath();
  const dueAt = Date.parse("2026-02-06T10:04:59.000Z");
  const first = createDueMainJob("start-arm-first", dueAt, dueAt);
  const second = createDueMainJob("start-arm-second", dueAt, dueAt);
  await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

  const state = createStartArmState(store.storePath, dueAt + 1_000);
  const dropTrigger = installOneShotTerminalWriteFailure(first.id);
  try {
    await expect(start(state)).rejects.toThrow("startup terminal write failed");
    expect(state.timer).not.toBeNull();
    expect(state.stopped).toBe(false);
    expect(state.schedulingPaused).toBe(false);
    expect(state.startupCatchup).toBeUndefined();
  } finally {
    dropTrigger();
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }
});

it("re-arms on the sibling timer tick after the same catch-up failure", async () => {
  const store = fixtures.makeStorePath();
  const dueAt = Date.parse("2026-02-06T10:04:59.000Z");
  const first = createDueMainJob("tick-arm-first", dueAt, dueAt);
  const second = createDueMainJob("tick-arm-second", dueAt, dueAt);
  await saveCronStore(store.storePath, { version: 1, jobs: [first, second] });

  const state = createStartArmState(store.storePath, dueAt + 1_000);
  const dropTrigger = installOneShotTerminalWriteFailure(first.id);
  try {
    await onTimer(state).catch(() => undefined);
    expect(state.timer).not.toBeNull();
  } finally {
    dropTrigger();
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }
});
