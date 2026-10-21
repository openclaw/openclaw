import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readCronJobScratchState, writeCronJobScratch } from "./scratch-store.js";
import { cronTestDeps, cronTestJob } from "./service.fixture-builders.test-support.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { run } from "./service/ops-run.js";
import { createCronServiceState, type CronEvent } from "./service/state.js";
import { onTimer, runMissedJobs } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-removal-postcommit-",
  baseTimeIso: "2026-07-10T12:00:00.000Z",
});

async function createFixture() {
  const { storePath } = await makeStorePath();
  const nowMs = Date.parse("2026-07-10T12:00:00.000Z");
  const runAtMs = nowMs - 60_000;
  const job = cronTestJob({
    id: "one-shot-removal",
    deleteAfterRun: true,
    schedule: { kind: "at", at: new Date(runAtMs).toISOString() },
    state: { nextRunAtMs: runAtMs },
  });
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const events: CronEvent[] = [];
  const durableStateAtRemoval: Array<
    Promise<{ jobs: CronJob[]; scratch: ReturnType<typeof readCronJobScratchState> }>
  > = [];
  const state = createCronServiceState(
    cronTestDeps({
      storePath,
      log: logger,
      nowMs: () => nowMs,
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        delivered: true,
      })),
      onEvent: (event) => {
        events.push(structuredClone(event));
        if (event.action === "removed") {
          const scratch = readCronJobScratchState(storePath, job.id);
          durableStateAtRemoval.push(
            loadCronStore(storePath).then((store) => ({ jobs: store.jobs, scratch })),
          );
        }
      },
    }),
  );
  const writeScratch = (content: string, sourceSha256?: string) =>
    writeCronJobScratch({ storePath, jobId: job.id, content, sourceSha256, nowMs: nowMs - 1 });
  return { storePath, job, events, state, durableStateAtRemoval, writeScratch };
}

beforeEach(resetGatewayWorkAdmission);

afterEach(() => {
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

describe("cron one-shot removal", () => {
  it("publishes removal after durable job and scratch deletion", async () => {
    const { job, events, state, durableStateAtRemoval, writeScratch } = await createFixture();
    expect(await writeScratch("original scratch")).toMatchObject({ ok: true, currentRevision: 1 });

    await run(state, job.id, "force");

    const relevantEvents = events.filter((event) => event.jobId === job.id);
    expect(relevantEvents.map((event) => event.action)).toEqual(["started", "finished", "removed"]);
    expect(relevantEvents.at(-1)?.job).toMatchObject({
      id: job.id,
      name: job.name,
      deleteAfterRun: true,
      state: { lastRunStatus: "ok", lastStatus: "ok" },
    });
    await expect(Promise.all(durableStateAtRemoval)).resolves.toEqual([
      { jobs: [], scratch: { currentRevision: 0 } },
    ]);
    expect(state.store?.jobs).toEqual([]);
  });

  it.each([
    { path: "timer", execute: onTimer },
    { path: "startup catch-up", execute: runMissedJobs },
  ])("restores $path wake state when the final deletion write fails", async ({ execute }) => {
    const { storePath, job, events, state, writeScratch } = await createFixture();
    await writeScratch("scratch must survive rollback", "original-source");
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
      await expect(execute(state)).rejects.toThrow("final persist failed");

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
    }
  });
});
