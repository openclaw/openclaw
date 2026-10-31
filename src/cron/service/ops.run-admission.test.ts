import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { loadCronStoreFromDatabase } from "../store/load.kernel.js";
import { cronStreamScheduleKey } from "../stream-schedule.js";
import { recomputeNextRunsForMaintenance } from "./jobs-scheduling.test-support.js";
import { stop } from "./ops-lifecycle.js";
import { remove, update } from "./ops-mutations.js";
import { enqueueRun, run, waitForManualRun } from "./ops-run.js";
import {
  createBlockedCronRun,
  createCronRunFixture,
  createHeldCronRunner,
} from "./ops.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-service-run-admission-" });
const dueAt = Date.parse("2026-02-06T10:05:05.250Z");

type CronStateParams = Parameters<typeof createCronRegressionState>[0];

function makeJob(id: string, nextRunAtMs = dueAt + 3_600_000) {
  return createDueIsolatedJob({ id, nowMs: dueAt, nextRunAtMs });
}

function blockedRun(
  job: ReturnType<typeof makeJob>,
  overrides: Partial<Omit<CronStateParams, "storePath">> = {},
) {
  return createBlockedCronRun(fixtures.makeStorePath().storePath, job, overrides);
}

describe("cron service run admission", () => {
  it("keeps a queued condition's ownership after a state edit before evaluation", async () => {
    const waitingJob = makeJob("condition-state-before-evaluation", dueAt);
    waitingJob.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt };
    waitingJob.trigger = { script: "fire", once: true };
    waitingJob.state.triggerState = { owner: "original" };
    const evaluateCronTrigger = vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: true,
      state: { owner: "completed evaluation" },
    }));
    const queue = await blockedRun(waitingJob, {
      cronConfig: { triggers: { enabled: true } },
      evaluateCronTrigger,
    });
    let waitingRun: ReturnType<typeof run> | undefined;
    try {
      waitingRun = run(queue.state, waitingJob.id, "due");
      await queue.queued;

      expect(queue.readReceipt()).toBeDefined();
      expect(evaluateCronTrigger).not.toHaveBeenCalled();
      await update(queue.state, waitingJob.id, {
        state: { triggerState: { owner: "queued edit" } },
      });

      await queue.finishActive();
      await expect(waitingRun).resolves.toEqual({ ok: true, ran: true });

      expect(evaluateCronTrigger.mock.calls).toMatchObject([[{ state: { owner: "queued edit" } }]]);
      const persisted = await queue.readJob();
      expect(persisted).toMatchObject({
        enabled: false,
        state: { triggerState: { owner: "completed evaluation" }, triggerEvalCount: 1 },
      });
      expect(persisted?.state.nextRunAtMs).toBeUndefined();
      expect(queue.readReceipt()).toBeUndefined();
    } finally {
      queue.releaseActive.resolve({ status: "ok" });
      stop(queue.state);
      await Promise.allSettled([queue.activeRun, waitingRun]);
    }
  });

  it("rechecks a queued if-enabled run after the job is disabled", async () => {
    const job = makeJob("queued-disabled-before-admission", dueAt);
    const onEvent = vi.fn();
    const { readJob, state, finishActive, targetCalls } = await blockedRun(job, { onEvent });
    try {
      const ack = await enqueueRun(state, job.id, "if-enabled");
      expect(ack).toMatchObject({ ok: true, enqueued: true, runId: expect.any(String) });
      await update(state, job.id, { enabled: false });
      await finishActive();
      if (!ack.ok || !("runId" in ack)) {
        throw new Error("Expected an acknowledged queued request");
      }
      expect(await waitForManualRun(state, ack.runId, 60_000)).toBe(true);
      expect(targetCalls()).toHaveLength(0);
      expect(onEvent.mock.calls.map(([event]) => event)).toContainEqual(
        expect.objectContaining({ jobId: job.id, action: "finished", status: "skipped" }),
      );
      expect((await readJob())?.state.queuedAtMs).toBeUndefined();
    } finally {
      await finishActive();
      stop(state);
    }
  });

  it.each(["payload-edited", "schedule-edited", "removed"] as const)(
    "uses current queued definitions and cancels replaced schedules: %s",
    async (mutation) => {
      const waitingJob = makeJob(`queued-before-${mutation}`);
      const { readReceipt, state, queued, finishActive, targetCalls } =
        await blockedRun(waitingJob);
      const waitingRun = run(state, waitingJob.id, "force");
      await queued;
      const staleReceipt = readReceipt();
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

      await finishActive({ status: "ok", summary: "active" });
      await expect(waitingRun).resolves.toEqual(
        mutation === "payload-edited"
          ? { ok: true, ran: true }
          : { ok: true, ran: false, reason: "not-due" },
      );
      expect(targetCalls()).toMatchObject(
        mutation === "payload-edited" ? [[{ message: "replacement generation" }]] : [],
      );
      const receipt = openOpenClawStateDatabase()
        .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
        .get(staleReceipt.receiptId) as { status: string } | undefined;
      expect(receipt?.status).toBe(mutation === "payload-edited" ? "ok" : "skipped");
    },
  );

  it("admits only current stream batches after an A-to-B-to-A source replacement", async () => {
    const streamJob = makeJob("queued-stream-replacement");
    streamJob.schedule = { kind: "stream", command: ["old-source"] };
    streamJob.state.streamSourceIdentity = "source-a";
    const queue = await blockedRun(streamJob, { cronConfig: { triggers: { enabled: true } } });
    const batch = {
      streamScheduleKey: cronStreamScheduleKey(streamJob.schedule),
      streamSourceIdentity: "source-a",
    };
    const waitingRun = run(queue.state, streamJob.id, "force", { ...batch, streamBatch: "stale" });
    await queue.queued;
    await update(queue.state, streamJob.id, {
      schedule: { kind: "stream", command: ["new-source"] },
    });
    const restored = await update(queue.state, streamJob.id, {
      schedule: { kind: "stream", command: ["old-source"] },
    });
    expect(restored.state.streamSourceIdentity).not.toBe("source-a");

    await queue.finishActive({ status: "ok", summary: "active" });
    await expect(waitingRun).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    await expect(
      run(queue.state, streamJob.id, "force", { ...batch, streamBatch: "stale-after-replacement" }),
    ).resolves.toEqual({ ok: true, ran: false, reason: "not-due" });
    expect(queue.targetCalls()).toHaveLength(0);
    const currentKey = batch.streamScheduleKey;
    const currentIdentity = restored.state.streamSourceIdentity;
    const retiredKey = cronStreamScheduleKey({ kind: "stream", command: ["retired-source"] });
    for (const [streamBatch, streamScheduleKey, streamSourceIdentity, count] of [
      ["from-a-retired-schedule", retiredKey, currentIdentity, 0],
      ["missing-source-identity", currentKey, undefined, 0],
      ["from-current-schedule", currentKey, currentIdentity, 1],
    ] as const) {
      const result = await run(queue.state, streamJob.id, "force", {
        streamBatch,
        streamScheduleKey,
        streamSourceIdentity,
      });
      if (count === 0) {
        expect(result).toEqual({ ok: true, ran: false, reason: "not-due" });
      }
      expect(queue.targetCalls()).toHaveLength(count);
    }
  });

  it("commits invalid-run state before notifying a subscriber that edits the job", async () => {
    const store = fixtures.makeStorePath();
    const storeKey = cronStoreKey(store.storePath);
    const job = makeJob("invalid-manual-stale-notification", dueAt);
    job.sessionTarget = "main";
    job.payload = { kind: "command", argv: ["echo", "invalid main payload"] };
    job.failureAlert = { after: 1, cooldownMs: 60_000, includeSkipped: true };
    const sendCronFailureAlert = vi.fn(async () => {});
    const editedName = "edited after invalid-run commit";
    let edited = false;
    let persistedStatusAtEvent: string | undefined;
    const { state } = await createCronRunFixture(store.storePath, job, {
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(),
      onEvent: (event) => {
        if (edited || event.action !== "finished" || event.jobId !== job.id) {
          return;
        }
        edited = true;
        const db = openOpenClawStateDatabase().db;
        persistedStatusAtEvent = loadCronStoreFromDatabase(db, storeKey).store.jobs.find(
          (entry) => entry.id === job.id,
        )?.state.lastRunStatus;
        db.prepare(
          "UPDATE cron_jobs SET name = ?, job_json = json_set(job_json, '$.name', ?), updated_at = updated_at + 1 WHERE store_key = ? AND job_id = ?",
        ).run(editedName, editedName, storeKey, job.id);
      },
    });

    const result = await run(state, job.id, "force");
    expect(result).toEqual({ ok: true, ran: false, reason: "invalid-spec" });

    expect(persistedStatusAtEvent).toBe("skipped");
    const persisted = (await loadCronStore(store.storePath)).jobs[0];
    expect(persisted).toMatchObject({ name: editedName, state: { lastRunStatus: "skipped" } });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
  });

  it("keeps queued force runs for jobs disabled before reservation through maintenance", async () => {
    const waitingJob = makeJob("queued-disabled-force");
    waitingJob.enabled = false;
    const { started: waitingStarted, release: releaseWaiting, runner } = createHeldCronRunner();
    const queue = await blockedRun(waitingJob, { runIsolatedAgentJob: runner });
    const currentState = () =>
      queue.state.store?.jobs.find((job) => job.id === waitingJob.id)?.state;
    const waitingRun = run(queue.state, waitingJob.id, "force");
    await queue.queued;
    recomputeNextRunsForMaintenance(queue.state, { deferredNotifications: [] });
    expect(currentState()?.queuedAtMs).toBe(dueAt);

    queue.releaseActive.resolve({ status: "ok", summary: "active" });
    await waitingStarted;
    expect(currentState()?.runningAtMs).toBe(dueAt);
    recomputeNextRunsForMaintenance(queue.state, { deferredNotifications: [] });
    expect(currentState()?.runningAtMs).toBe(dueAt);
    releaseWaiting.resolve({ status: "ok", summary: "waiting" });
    await Promise.all([queue.activeRun, waitingRun]);
  });
});
