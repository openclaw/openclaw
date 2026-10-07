import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { readCronJobScratchState, writeCronJobScratch } from "./scratch-store.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { run } from "./service/ops-run.js";
import { createCronServiceState, type CronEvent, type CronServiceState } from "./service/state.js";
import { runMissedJobs } from "./service/timer.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-removal-postcommit-",
  baseTimeIso: "2026-07-10T12:00:00.000Z",
});

type RemovalPath = "manual" | "timer" | "startup catch-up";

function createDueOneShot(id: string, nowMs: number): CronJob {
  const runAtMs = nowMs - 60_000;
  return {
    id,
    name: `delete ${id}`,
    enabled: true,
    deleteAfterRun: true,
    createdAtMs: runAtMs - 60_000,
    updatedAtMs: runAtMs - 60_000,
    schedule: { kind: "at", at: new Date(runAtMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "do work" },
    state: { nextRunAtMs: runAtMs },
  };
}

async function createFixture(path: RemovalPath, captureRemoval = false) {
  const { storePath } = await makeStorePath();
  const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
  const job = createDueOneShot(`removal-${path.replaceAll(" ", "-")}`, nowMs);
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const events: CronEvent[] = [];
  const durableStateAtRemoval: Array<
    Promise<{ jobs: CronJob[]; scratch: ReturnType<typeof readCronJobScratchState> }>
  > = [];
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => nowMs,
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: true,
    })),
    onEvent: (event) => {
      events.push(structuredClone(event));
      if (captureRemoval && event.action === "removed") {
        const scratch = readCronJobScratchState(storePath, job.id);
        durableStateAtRemoval.push(
          loadCronStore(storePath).then((store) => ({ jobs: store.jobs, scratch })),
        );
      }
    },
  });
  return { storePath, nowMs, job, events, state, durableStateAtRemoval };
}

async function executeRemovalPath(
  path: RemovalPath,
  state: CronServiceState,
  jobId: string,
): Promise<void> {
  if (path === "manual") {
    await run(state, jobId, "force");
    return;
  }
  if (path === "timer") {
    await onTimer(state);
    return;
  }
  await runMissedJobs(state);
}

function clearStateTimer(state: CronServiceState): void {
  if (state.timer) {
    state.timer.cancel();
    state.timer = null;
  }
}

beforeEach(resetGatewayWorkAdmission);

afterEach(() => {
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

describe("cron one-shot removal", () => {
  it("publishes removal after durable job and scratch deletion", async () => {
    const path = "manual";
    const { storePath, nowMs, job, events, state, durableStateAtRemoval } = await createFixture(
      path,
      true,
    );
    expect(
      await writeCronJobScratch({
        storePath,
        jobId: job.id,
        content: "original scratch",
        nowMs: nowMs - 1,
      }),
    ).toMatchObject({ ok: true, currentRevision: 1 });

    try {
      await executeRemovalPath(path, state, job.id);

      const relevantEvents = events.filter((event) => event.jobId === job.id);
      expect(relevantEvents.map((event) => event.action)).toEqual([
        "started",
        "finished",
        "removed",
      ]);
      const removed = relevantEvents.at(-1);
      expect(removed).toMatchObject({
        action: "removed",
        jobId: job.id,
        job: {
          id: job.id,
          name: job.name,
          deleteAfterRun: true,
          state: {
            lastRunStatus: "ok",
            lastStatus: "ok",
          },
        },
      });
      expect(durableStateAtRemoval).toHaveLength(1);
      await expect(Promise.all(durableStateAtRemoval)).resolves.toEqual([
        { jobs: [], scratch: { currentRevision: 0 } },
      ]);
      expect(state.store?.jobs).toEqual([]);
    } finally {
      clearStateTimer(state);
    }
  });

  it.each(["timer", "startup catch-up"] as const)(
    "restores %s wake state when the final deletion write fails",
    async (path) => {
      const { storePath, nowMs, job, events, state } = await createFixture(path);
      await writeCronJobScratch({
        storePath,
        jobId: job.id,
        content: "scratch must survive rollback",
        sourceSha256: "original-source",
        nowMs: nowMs - 1,
      });
      const scratchBefore = readCronJobScratchState(storePath, job.id);

      const database = openOpenClawStateDatabase().db;
      database.exec(`
      CREATE TRIGGER reject_final_cron_job_delete
      BEFORE DELETE ON cron_jobs
      WHEN OLD.store_key = '${cronStoreKey(storePath)}' AND OLD.job_id = '${job.id}'
      BEGIN
        SELECT RAISE(ABORT, 'final persist failed');
      END;
    `);

      try {
        await expect(executeRemovalPath(path, state, job.id)).rejects.toThrow(
          "final persist failed",
        );

        expect(events.some((event) => event.action === "removed")).toBe(false);

        const durableStore = await loadCronStore(storePath);
        expect(state.store).toEqual(durableStore);
        const durableJob = durableStore.jobs[0];
        expect(durableJob?.id).toBe(job.id);
        expect(state.durableNextRunAtMsByJobId).toEqual(
          new Map([[job.id, durableJob?.state.nextRunAtMs]]),
        );
        expect(readCronJobScratchState(storePath, job.id)).toEqual(scratchBefore);
      } finally {
        database.exec("DROP TRIGGER IF EXISTS reject_final_cron_job_delete");
        clearStateTimer(state);
      }
    },
  );
});
