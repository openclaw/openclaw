// Shared cron run-admission regressions cover cross-trigger limits and queued-run cleanup.
import { describe, expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { loadCronStoreFromDatabase } from "../store/load.kernel.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import { cronStreamScheduleKey } from "../stream-schedule.js";
import { recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { stop } from "./ops-lifecycle.js";
import { remove, update } from "./ops-mutations.js";
import { enqueueRun, run, waitForManualRun } from "./ops-run.js";
import { onTimer } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-run-admission-",
});

type CronStateParams = Parameters<typeof createCronRegressionState>[0];
type IsolatedRunner = CronStateParams["runIsolatedAgentJob"];

function makeJob(id: string, nowMs: number, nextRunAtMs = nowMs + 3_600_000) {
  return createDueIsolatedJob({ id, nowMs, nextRunAtMs });
}

async function blockedRun(
  waitingJob: ReturnType<typeof createDueIsolatedJob>,
  overrides: Partial<Omit<CronStateParams, "storePath">> = {},
) {
  const store = opsRegressionFixtures.makeStorePath();
  const activeJobs = Array.from({ length: 8 }, (_, index) =>
    makeJob(`${waitingJob.id}-blocker-${index}`, waitingJob.createdAtMs),
  );
  await saveCronStore(store.storePath, { version: 1, jobs: [...activeJobs, waitingJob] });
  const started = createDeferred();
  const releaseActive = createDeferred<Awaited<ReturnType<IsolatedRunner>>>();
  let startedCount = 0;
  const runIsolatedAgentJob = vi.fn<IsolatedRunner>(async (params) => {
    if (activeJobs.some((job) => job.id === params.job.id)) {
      if (++startedCount === activeJobs.length) {
        started.resolve();
      }
      return await releaseActive.promise;
    }
    return overrides.runIsolatedAgentJob
      ? await overrides.runIsolatedAgentJob(params)
      : { status: "ok" };
  });
  const state = createCronRegressionState({
    ...overrides,
    storePath: store.storePath,
    nowMs: overrides.nowMs ?? (() => waitingJob.createdAtMs),
    runIsolatedAgentJob,
  });
  const activeRun = Promise.all(activeJobs.map((job) => run(state, job.id, "force")));
  await started.promise;
  const queued = createDeferred();
  observeCronJobCommits(waitingJob.id, ({ queuedAtMs }) => {
    if (queuedAtMs !== undefined) {
      queued.resolve();
    }
  });
  return { store, state, runIsolatedAgentJob, activeRun, releaseActive, queued: queued.promise };
}

describe("cron service run admission", () => {
  it("keeps a queued condition's ownership after a state edit before evaluation", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:04.000Z");
    const waitingJob = makeJob("condition-state-before-evaluation", dueAt, dueAt);
    waitingJob.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt };
    waitingJob.trigger = { script: "fire", once: true };
    waitingJob.state.triggerState = { owner: "original" };
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: true,
      state: { owner: "completed evaluation" },
    }));
    const { store, state, runIsolatedAgentJob, activeRun, releaseActive, queued } =
      await blockedRun(waitingJob, {
        cronConfig: { triggers: { enabled: true } },
        evaluateCronTrigger,
      });
    let waitingRun: ReturnType<typeof run> | undefined;
    try {
      waitingRun = run(state, waitingJob.id, "due");
      await queued;

      expect(
        inspectActiveCronRunReceipt({ storePath: store.storePath, jobId: waitingJob.id }),
      ).toBeDefined();
      expect(evaluateCronTrigger).not.toHaveBeenCalled();
      await update(state, waitingJob.id, { state: { triggerState: { owner: "queued edit" } } });

      releaseActive.resolve({ status: "ok" });
      await activeRun;
      await expect(waitingRun).resolves.toEqual({ ok: true, ran: true });

      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      expect(evaluateCronTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ state: { owner: "queued edit" } }),
      );
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(9);
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (job) => job.id === waitingJob.id,
      );
      expect(persisted).toMatchObject({
        enabled: false,
        state: { triggerState: { owner: "completed evaluation" }, triggerEvalCount: 1 },
      });
      expect(persisted?.state.nextRunAtMs).toBeUndefined();
      expect(
        inspectActiveCronRunReceipt({ storePath: store.storePath, jobId: waitingJob.id }),
      ).toBeUndefined();
    } finally {
      releaseActive.resolve({ status: "ok" });
      stop(state);
      await Promise.allSettled([activeRun, waitingRun]);
    }
  });

  it("rechecks a queued if-enabled run after the job is disabled", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:04.000Z");
    const job = makeJob("queued-disabled-before-admission", dueAt, dueAt);
    const onEvent = vi.fn();
    const { store, state, runIsolatedAgentJob, activeRun, releaseActive } = await blockedRun(job, {
      onEvent,
    });
    try {
      const ack = await enqueueRun(state, job.id, "if-enabled");
      expect(ack).toMatchObject({ ok: true, enqueued: true, runId: expect.any(String) });
      await update(state, job.id, { enabled: false });
      releaseActive.resolve({ status: "ok" });
      await activeRun;
      if (!ack.ok || !("runId" in ack)) {
        throw new Error("Expected an acknowledged queued request");
      }
      expect(await waitForManualRun(state, ack.runId, 60_000)).toBe(true);
      expect(
        runIsolatedAgentJob.mock.calls.some(([{ job: started }]) => started.id === job.id),
      ).toBe(false);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          action: "finished",
          status: "skipped",
        }),
      );
      expect(
        (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
          .queuedAtMs,
      ).toBeUndefined();
    } finally {
      releaseActive.resolve({ status: "ok" });
      await activeRun;
      stop(state);
    }
  });

  it("drains a burst of scheduled jobs without exceeding shared admission", async () => {
    vi.useRealTimers();
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:05.250Z");
    const jobs = Array.from({ length: 40 }, (_, index) =>
      makeJob(`scheduled-admission-burst-${index}`, dueAt, dueAt),
    );
    await saveCronStore(store.storePath, { version: 1, jobs });

    let active = 0;
    let peakActive = 0;
    const completed = new Set<string>();
    const releaseRunners = createDeferred();
    const firstWaveStarted = createDeferred();
    const clock = createGatewaySchedulerClock(dueAt);
    const state = createCronRegressionState({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath: store.storePath,
      nowMs: () => dueAt,
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: { id: string } }) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        if (active === 8) {
          firstWaveStarted.resolve();
        }
        await releaseRunners.promise;
        active -= 1;
        completed.add(job.id);
        return { status: "ok" as const, summary: job.id };
      }),
    });

    const timer = onTimer(state);
    try {
      await firstWaveStarted.promise;
      releaseRunners.resolve();
      await timer;

      expect(completed).toEqual(new Set(jobs.map((job) => job.id)));
      expect(peakActive).toBe(8);
      const persisted = await loadCronStore(store.storePath);
      expect(
        persisted.jobs.every(
          (job) => job.state.queuedAtMs === undefined && job.state.runningAtMs === undefined,
        ),
      ).toBe(true);
    } finally {
      stop(state);
      releaseRunners.resolve();
      await timer;
      await state.schedulerDrain;
    }
  });

  it.each(["payload-edited", "schedule-edited", "removed"] as const)(
    "uses current queued definitions and cancels replaced schedules: %s",
    async (mutation) => {
      const dueAt = Date.parse("2026-02-06T10:05:06.050Z");
      const waitingJob = makeJob(`queued-before-${mutation}`, dueAt);
      const { store, state, runIsolatedAgentJob, activeRun, releaseActive, queued } =
        await blockedRun(waitingJob);
      const waitingRun = run(state, waitingJob.id, "force");
      await queued;
      const staleReceipt = inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: waitingJob.id,
      });
      if (!staleReceipt) {
        throw new Error("Expected the queued run to own a durable receipt");
      }

      if (mutation === "removed") {
        await remove(state, waitingJob.id);
      } else if (mutation === "schedule-edited") {
        await update(state, waitingJob.id, {
          schedule: { kind: "every", everyMs: 60_000, anchorMs: dueAt },
        });
      } else {
        await update(state, waitingJob.id, {
          payload: { kind: "agentTurn", message: "replacement generation" },
        });
      }

      releaseActive.resolve({ status: "ok", summary: "active" });
      await activeRun;
      await expect(waitingRun).resolves.toEqual(
        mutation === "payload-edited"
          ? { ok: true, ran: true }
          : { ok: true, ran: false, reason: "not-due" },
      );
      const calls = runIsolatedAgentJob.mock.calls.filter(([{ job }]) => job.id === waitingJob.id);
      expect(calls).toHaveLength(mutation === "payload-edited" ? 1 : 0);
      if (mutation === "payload-edited") {
        expect(calls[0]?.[0].message).toBe("replacement generation");
      }
      const receipt = openOpenClawStateDatabase()
        .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(staleReceipt.receiptId) as { status: string } | undefined;
      expect(receipt?.status).toBe(mutation === "payload-edited" ? "ok" : "skipped");
    },
  );

  it("cancels a queued stream batch after an A-to-B-to-A source replacement", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:06.100Z");
    const streamJob = makeJob("queued-stream-replacement", dueAt);
    streamJob.schedule = { kind: "stream", command: ["old-source"] };
    streamJob.state.streamSourceIdentity = "source-a";
    const { state, runIsolatedAgentJob, activeRun, releaseActive, queued } = await blockedRun(
      streamJob,
      {
        cronConfig: { triggers: { enabled: true } },
      },
    );
    const streamScheduleKey = cronStreamScheduleKey(streamJob.schedule);
    const waitingRun = run(state, streamJob.id, "force", {
      streamBatch: "stale",
      streamScheduleKey,
      streamSourceIdentity: "source-a",
    });
    await queued;
    await update(state, streamJob.id, {
      schedule: { kind: "stream", command: ["new-source"] },
    });
    const restored = await update(state, streamJob.id, {
      schedule: { kind: "stream", command: ["old-source"] },
    });
    expect(restored.state.streamSourceIdentity).not.toBe("source-a");

    releaseActive.resolve({ status: "ok", summary: "active" });
    await activeRun;
    await expect(waitingRun).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    await expect(
      run(state, streamJob.id, "force", {
        streamBatch: "stale-after-replacement",
        streamScheduleKey,
        streamSourceIdentity: "source-a",
      }),
    ).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(8);
  });

  it("skips an immediately-executed stream batch whose schedule key is stale", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.150Z");
    const streamJob = makeJob("immediate-stale-stream", dueAt, dueAt + 3_600_000);
    streamJob.schedule = { kind: "stream", command: ["current-source"] };
    streamJob.state.streamSourceIdentity = "current-source-identity";
    await saveCronStore(store.storePath, { version: 1, jobs: [streamJob] });

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "ran" }));
    const state = createCronRegressionState({
      storePath: store.storePath,
      cronConfig: { triggers: { enabled: true } },
      nowMs: () => dueAt,
      runIsolatedAgentJob,
    });

    // A batch tagged with a schedule key that never matched the current
    // schedule must be dropped at the execution guard, not fired.
    await expect(
      run(state, streamJob.id, "force", {
        streamBatch: "from-a-retired-schedule",
        streamScheduleKey: cronStreamScheduleKey({ kind: "stream", command: ["retired-source"] }),
        streamSourceIdentity: "current-source-identity",
      }),
    ).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();

    // The definition key alone is not an ownership claim; identity is mandatory.
    await expect(
      run(state, streamJob.id, "force", {
        streamBatch: "missing-source-identity",
        streamScheduleKey: cronStreamScheduleKey(streamJob.schedule),
      }),
    ).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });

    // A batch tagged with the current source definition and identity still fires.
    await run(state, streamJob.id, "force", {
      streamBatch: "from-current-schedule",
      streamScheduleKey: cronStreamScheduleKey(streamJob.schedule),
      streamSourceIdentity: "current-source-identity",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("commits invalid-run state before notifying a subscriber that edits the job", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:06.200Z");
    const job = makeJob("invalid-manual-stale-notification", dueAt, dueAt);
    job.sessionTarget = "main";
    job.payload = { kind: "command", argv: ["true"] };
    job.failureAlert = { after: 1, cooldownMs: 60_000, includeSkipped: true };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const sendCronFailureAlert = vi.fn(async () => {});
    const editedName = "edited after invalid-run commit";
    let edited = false;
    let persistedStatusAtEvent: string | undefined;
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => dueAt,
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(),
      onEvent: (event) => {
        if (edited || event.action !== "finished" || event.jobId !== job.id) {
          return;
        }
        edited = true;
        const db = openOpenClawStateDatabase().db;
        persistedStatusAtEvent = loadCronStoreFromDatabase(
          db,
          cronStoreKey(store.storePath),
        ).store.jobs.find((entry) => entry.id === job.id)?.state.lastRunStatus;
        db.prepare(
          "UPDATE cron_jobs SET name = ?, job_json = json_set(job_json, '$.name', ?), updated_at = updated_at + 1 WHERE store_key = ? AND job_id = ?",
        ).run(editedName, editedName, cronStoreKey(store.storePath), job.id);
      },
    });

    await expect(run(state, job.id, "force")).resolves.toEqual({
      ok: true,
      ran: false,
      reason: "invalid-spec",
    });

    expect(persistedStatusAtEvent).toBe("skipped");
    const persisted = (await loadCronStore(store.storePath)).jobs[0];
    expect(persisted?.name).toBe(editedName);
    expect(persisted?.state.lastRunStatus).toBe("skipped");
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
  });

  it("keeps queued force runs for jobs disabled before reservation through maintenance", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:06.625Z");
    const waitingJob = makeJob("queued-disabled-force", dueAt);
    waitingJob.enabled = false;
    const waitingStarted = createDeferred();
    const releaseWaiting = createDeferred<{ status: "ok"; summary: string }>();
    const { state, runIsolatedAgentJob, activeRun, releaseActive, queued } = await blockedRun(
      waitingJob,
      {
        runIsolatedAgentJob: async () => {
          waitingStarted.resolve();
          return await releaseWaiting.promise;
        },
      },
    );
    const waitingRun = run(state, waitingJob.id, "force");
    await queued;
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(dueAt);

    releaseActive.resolve({ status: "ok", summary: "active" });
    await waitingStarted.promise;
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.runningAtMs).toBe(
      dueAt,
    );
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });
    expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.runningAtMs).toBe(
      dueAt,
    );
    releaseWaiting.resolve({ status: "ok", summary: "waiting" });
    await Promise.all([activeRun, waitingRun]);

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(9);
  });
});
