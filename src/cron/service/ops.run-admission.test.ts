// Shared cron run-admission regressions cover cross-trigger limits and queued-run cleanup.
import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  getTotalQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
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
import { enqueueRun, run } from "./ops-run.js";
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
  overrides: Partial<Omit<CronStateParams, "storePath" | "testAdmissionLimit">> = {},
) {
  const store = opsRegressionFixtures.makeStorePath();
  const activeJob = makeJob(`${waitingJob.id}-blocker`, waitingJob.createdAtMs);
  await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, waitingJob] });
  const started = createDeferred();
  const releaseActive = createDeferred<Awaited<ReturnType<IsolatedRunner>>>();
  const runIsolatedAgentJob = vi.fn<IsolatedRunner>(async (params) => {
    if (params.job.id === activeJob.id) {
      started.resolve();
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
    testAdmissionLimit: 1,
    runIsolatedAgentJob,
  });
  const activeRun = run(state, activeJob.id, "force");
  await started.promise;
  return { store, state, runIsolatedAgentJob, activeRun, releaseActive };
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
    const { store, state, runIsolatedAgentJob, activeRun, releaseActive } = await blockedRun(
      waitingJob,
      { cronConfig: { triggers: { enabled: true } }, evaluateCronTrigger },
    );
    let waitingRun: ReturnType<typeof run> | undefined;
    try {
      waitingRun = run(state, waitingJob.id, "due");
      await vi.waitFor(async () => {
        const waiting = (await loadCronStore(store.storePath)).jobs.find(
          (job) => job.id === waitingJob.id,
        );
        expect(waiting?.state.queuedAtMs).toBe(dueAt);
        expect(waiting?.state.runningAtMs).toBeUndefined();
      });
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
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
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
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:04.000Z");
    const job = makeJob("queued-disabled-before-admission", dueAt, dueAt);
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const blockerStarted = createDeferred();
    const releaseBlocker = createDeferred();
    const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
      blockerStarted.resolve();
      return await releaseBlocker.promise;
    });
    await blockerStarted.promise;

    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const onEvent = vi.fn();
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => dueAt,
      runIsolatedAgentJob,
      onEvent,
    });

    expect(await enqueueRun(state, job.id, "if-enabled")).toMatchObject({
      ok: true,
      enqueued: true,
      runId: expect.any(String),
    });
    await update(state, job.id, { enabled: false });
    releaseBlocker.resolve();
    await blocker;
    await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0), { timeout: 5_000 });

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        action: "finished",
        status: "skipped",
        error: "queued manual run skipped before execution: disabled",
      }),
    );
    clearCommandLane(CommandLane.Cron);
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
      testAdmissionLimit: 4,
      nowMs: () => dueAt,
      runIsolatedAgentJob: vi.fn(async ({ job }: { job: { id: string } }) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        if (active === 4) {
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
      for (let wave = 0; completed.size < jobs.length && wave < jobs.length; wave += 1) {
        const capacityTick = clock.advanceBy(0);
        if (!capacityTick) {
          throw new Error("Expected a capacity wake while scheduled jobs remain");
        }
        await capacityTick;
      }

      expect(completed).toEqual(new Set(jobs.map((job) => job.id)));
      expect(peakActive).toBe(4);
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

  it("finalizes an admitted scheduled sibling before surfacing an activation failure", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:05.500Z");
    const completingJob = makeJob("a-completing-before-batch-failure", dueAt, dueAt);
    const failingJob = makeJob("b-failing-batch-activation", dueAt, dueAt);
    const queuedJob = makeJob("c-queued-after-batch-failure", dueAt, dueAt);
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [completingJob, failingJob, queuedJob],
    });

    const completingStarted = createDeferred();
    const releaseCompleting = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: { id: string } }) => {
      expect(job.id).toBe(completingJob.id);
      completingStarted.resolve();
      return await releaseCompleting.promise;
    });
    const state = createCronRegressionState({
      storePath: store.storePath,
      testAdmissionLimit: 2,
      nowMs: () => dueAt,
      runIsolatedAgentJob,
    });
    inspectActiveCronRunReceipt({ storePath: store.storePath, jobId: failingJob.id });
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TRIGGER reject_scheduled_sibling_activation
      BEFORE UPDATE OF started_at_ms ON cron_run_receipts
      WHEN NEW.job_id = '${failingJob.id}'
      BEGIN
        SELECT RAISE(ABORT, 'scheduled sibling activation failed');
      END;
    `);

    const timerRun = onTimer(state);
    try {
      await completingStarted.promise;
      releaseCompleting.resolve({ status: "ok", summary: "completed sibling" });
      await expect(timerRun).rejects.toThrow("scheduled sibling activation failed");
    } finally {
      releaseCompleting.resolve({ status: "ok", summary: "completed sibling" });
      await Promise.allSettled([timerRun]);
      database.exec("DROP TRIGGER IF EXISTS reject_scheduled_sibling_activation");
      stop(state);
    }

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    const persisted = await loadCronStore(store.storePath);
    expect(persisted.jobs.find((job) => job.id === completingJob.id)?.state.lastRunStatus).toBe(
      "ok",
    );
    expect(
      persisted.jobs.find((job) => job.id === completingJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(
      persisted.jobs.find((job) => job.id === failingJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(
      persisted.jobs.find((job) => job.id === queuedJob.id)?.state.lastRunStatus,
    ).toBeUndefined();
    expect(
      persisted.jobs.find((job) => job.id === queuedJob.id)?.state.runningAtMs,
    ).toBeUndefined();
  });

  it.each(["edited-and-restored", "removed"] as const)(
    "fences and settles a queued manual run after its job is %s",
    async (mutation) => {
      const dueAt = Date.parse("2026-02-06T10:05:06.050Z");
      const waitingJob = makeJob(`queued-before-${mutation}`, dueAt);
      const { store, state, runIsolatedAgentJob, activeRun, releaseActive } =
        await blockedRun(waitingJob);
      const waitingRun = run(state, waitingJob.id, "force");
      await vi.waitFor(() => {
        expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(true);
      });
      const staleReceipt = inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: waitingJob.id,
      });
      if (!staleReceipt) {
        throw new Error("Expected the queued run to own a durable receipt");
      }

      if (mutation === "removed") {
        await remove(state, waitingJob.id);
      } else {
        await update(state, waitingJob.id, {
          payload: { kind: "agentTurn", message: "replacement generation" },
        });
        await update(state, waitingJob.id, { payload: waitingJob.payload });
      }

      releaseActive.resolve({ status: "ok", summary: "active" });
      await activeRun;
      await expect(waitingRun).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(false);
      const receipt = openOpenClawStateDatabase()
        .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(staleReceipt.receiptId) as { status: string } | undefined;
      expect(receipt?.status).toBe("skipped");
      if (mutation === "edited-and-restored") {
        const persisted = (await loadCronStore(store.storePath)).jobs.find(
          (job) => job.id === waitingJob.id,
        );
        expect(persisted?.state.queuedAtMs).toBeUndefined();
        expect(persisted?.state.runningAtMs).toBeUndefined();
        await expect(run(state, waitingJob.id, "force")).resolves.toEqual({ ok: true, ran: true });
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("cancels a queued stream batch after an A-to-B-to-A source replacement", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:06.100Z");
    const streamJob = makeJob("queued-stream-replacement", dueAt);
    streamJob.schedule = { kind: "stream", command: ["old-source"] };
    streamJob.state.streamSourceIdentity = "source-a";
    const { state, runIsolatedAgentJob, activeRun, releaseActive } = await blockedRun(streamJob, {
      cronConfig: { triggers: { enabled: true } },
    });
    const streamScheduleKey = cronStreamScheduleKey(streamJob.schedule);
    const waitingRun = run(state, streamJob.id, "force", {
      streamBatch: "stale",
      streamScheduleKey,
      streamSourceIdentity: "source-a",
    });
    await vi.waitFor(() => {
      expect(state.queuedRunReservationsByJobId.has(streamJob.id)).toBe(true);
    });
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
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
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
      testAdmissionLimit: 1,
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

  it("keeps a same-millisecond replacement reservation when stale cleanup runs", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:06.250Z");
    const waitingJob = makeJob("same-ms-replacement-reservation", dueAt);
    const replacementStarted = createDeferred();
    const { state, runIsolatedAgentJob, activeRun, releaseActive } = await blockedRun(waitingJob, {
      runIsolatedAgentJob: async () => {
        replacementStarted.resolve();
        return { status: "ok", summary: "replacement" };
      },
    });
    const staleRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(true);
    });
    const staleIdentity = state.queuedRunReservationsByJobId.get(waitingJob.id)?.identity;
    await update(state, waitingJob.id, { enabled: false });

    const replacementRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.queuedRunReservationsByJobId.get(waitingJob.id)?.identity).not.toBe(
        staleIdentity,
      );
      expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });

    releaseActive.resolve({ status: "ok", summary: "active" });
    await expect(staleRun).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    await replacementStarted.promise;
    await Promise.all([activeRun, replacementRun]);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("keeps queued force runs for jobs disabled before reservation through maintenance", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:06.625Z");
    const waitingJob = makeJob("queued-disabled-force", dueAt);
    waitingJob.enabled = false;
    const waitingStarted = createDeferred();
    const releaseWaiting = createDeferred<{ status: "ok"; summary: string }>();
    const { state, runIsolatedAgentJob, activeRun, releaseActive } = await blockedRun(waitingJob, {
      runIsolatedAgentJob: async () => {
        waitingStarted.resolve();
        return await releaseWaiting.promise;
      },
    });
    const waitingRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });
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

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });
});
