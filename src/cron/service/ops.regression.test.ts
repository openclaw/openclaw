import { expect, it, vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createCronRegressionState,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
} from "../../gateway/device-revocation.js";
import { resolveCronMutationCommitGuard } from "../../gateway/server-methods/cron-caller-scope.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  enqueueCommandInLane,
  getTotalQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isCronJobActive } from "../active-jobs.js";
import { createCronMutationCompletion } from "../mutation-completion.js";
import {
  readCronRunHistoryPageForTests,
  readCronRunRecordsForTests,
} from "../run-history.test-support.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronEvent, CronJob } from "../types.js";
import { remove, update } from "./ops-mutations.js";
import { enqueueRun, run, waitForManualRun } from "./ops-run.js";
import { ensureLoaded } from "./store.js";
import { onTimer } from "./timer.test-support.js";

const FAST_TIMEOUT_SECONDS = 1;
const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-ops-regressions-",
});

async function prepareJob(
  job: CronJob,
  deps: Omit<Parameters<typeof createCronRegressionState>[0], "storePath">,
) {
  const { storePath } = opsRegressionFixtures.makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  return createCronRegressionState({ storePath, ...deps });
}

function dueJob(id: string, nowMs: number, nextRunAtMs = nowMs) {
  return createDueIsolatedJob({ id, nowMs, nextRunAtMs });
}

function recurringJob(id: string, scheduledAt: number, overrides: Partial<CronJob> = {}): CronJob {
  return {
    ...createIsolatedRegressionJob({
      id,
      name: id,
      scheduledAt,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt },
      payload: { kind: "agentTurn", message: id },
      state: { nextRunAtMs: scheduledAt },
    }),
    ...overrides,
  };
}

function terminalEvents(jobId: string, status?: CronEvent["status"], clone = false) {
  const finished = createDeferred<CronEvent>();
  const events: CronEvent[] = [];
  return {
    finished: finished.promise,
    events,
    onEvent: (event: CronEvent) => {
      events.push(clone ? structuredClone(event) : event);
      if (
        event.jobId === jobId &&
        event.action === "finished" &&
        (!status || event.status === status)
      ) {
        finished.resolve(event);
      }
    },
  };
}

function waitForAbort(abortSignal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (abortSignal.aborted) {
      resolve();
    } else {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
}

function expectQueuedRunAck(result: unknown) {
  const ack = result as { ok?: unknown; enqueued?: unknown; runId?: unknown };
  expect(ack.ok).toBe(true);
  expect(ack.enqueued).toBe(true);
  expect(typeof ack.runId).toBe("string");
  return ack.runId as string;
}

function latestRunReceipt(storePath: string, jobId: string) {
  return openOpenClawStateDatabase()
    .db.prepare(
      "SELECT status, error_text AS error FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC, receipt_id DESC LIMIT 1",
    )
    .get(cronStoreKey(storePath), jobId) as { status: string; error: string | null };
}

function expectSingleEvent(events: readonly unknown[], expected: object) {
  expect(events).toEqual([expect.objectContaining(expected)]);
}

it("transfers queued manual runs out of the released request root", async () => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();

  const childLane = "cron-manual-admission-child";
  setCommandLaneConcurrency(childLane, 1);
  const now = Date.parse("2026-02-06T10:05:00.000Z");
  const job = dueJob("manual-admission-continuation", now);

  const enterRunner = createDeferred();
  const runnerStarted = createDeferred();
  const terminal = terminalEvents(job.id);
  const state = await prepareJob(job, {
    nowMs: () => now,
    runIsolatedAgentJob: vi.fn(async () => {
      runnerStarted.resolve();
      await enterRunner.promise;
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
      await enqueueCommandInLane(childLane, async () => undefined);
      return { status: "ok" as const };
    }),
    onEvent: terminal.onEvent,
  });
  const requestRoot = tryBeginGatewayRootWorkAdmission();
  expect(requestRoot?.ownsRoot).toBe(true);

  try {
    await requestRoot?.run(async () => {
      expectQueuedRunAck(await enqueueRun(state, job.id, "force"));
      await runnerStarted.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(2);
    });
    requestRoot?.release();
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    enterRunner.resolve();
    expect(await terminal.finished).toMatchObject({ status: "ok" });
    await Promise.all(state.queuedManualRuns.values());
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  } finally {
    requestRoot?.release();
    enterRunner.resolve();
    await Promise.allSettled(state.queuedManualRuns.values());
    resetGatewayWorkAdmission();
  }
});

it("rejects queueing when detached admission is already closed", async () => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
  const now = Date.parse("2026-02-06T10:05:00.000Z");
  const job = dueJob("manual-admission-closed", now);

  const onEvent = vi.fn();
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const state = await prepareJob(job, {
    nowMs: () => now,
    runIsolatedAgentJob,
    onEvent,
  });
  const context = {} as GatewayRequestContext;
  const caller = captureGatewayDeviceRevocation(
    context,
    { deviceId: "closed-admission-device", role: "operator" },
    () => true,
  );
  const commitGuard = resolveCronMutationCommitGuard(null, context, undefined, {
    hasCurrentClientAuthority: caller.isCurrent,
  });
  const completion = createCronMutationCompletion("cron.run");
  if (!completion) {
    throw new Error("Expected Cron completion owner");
  }

  try {
    markGatewayRestartDraining();
    await expect(
      completion.run(() => enqueueRun(state, job.id, "force", { commitGuard })),
    ).rejects.toThrow("Gateway is restarting. Please try again shortly.");
    expect(completion.isCommitted()).toBe(false);
    expect(getTotalQueueSize()).toBe(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    caller.release();
    expect(caller.isCurrent()).toBe(false);
  } finally {
    caller.release();
    closeGatewayDeviceRevocation(context);
    resetGatewayWorkAdmission();
  }
});

it("keeps an acknowledged manual run ahead of a later timer tick", async ({ signal }) => {
  vi.useRealTimers();

  const dueAt = Date.now() - 1;
  const job = recurringJob("timer-overlap", dueAt, {
    schedule: { kind: "at", at: new Date(dueAt).toISOString() },
  });
  const result = createDeferred<{ status: "ok"; summary: string }>();
  const started = createDeferred();
  const terminal = terminalEvents(job.id, "ok");
  const runIsolatedAgentJob = vi.fn(async () => {
    started.resolve();
    return await result.promise;
  });

  const state = await prepareJob(job, {
    runIsolatedAgentJob,
    onEvent: terminal.onEvent,
  });

  try {
    const runId = expectQueuedRunAck(await enqueueRun(state, job.id, "force"));
    await withinTest(started.promise, signal);

    await onTimer(state);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    result.resolve({ status: "ok", summary: "done" });
    await withinTest(terminal.finished, signal);
    await expect(waitForManualRun(state, runId, 5_000, signal)).resolves.toBe(true);
    const finished = terminal.events.filter((event) => event.action === "finished");
    expectSingleEvent(finished, { jobId: job.id, action: "finished", status: "ok", runId });
  } finally {
    result.resolve({ status: "ok", summary: "done" });
    await Promise.allSettled(state.queuedManualRuns.values());
  }
});

it("manual due runs honor retry backoff while force can run the preserved occurrence", async () => {
  const nowMs = Date.parse("2026-09-30T09:00:00.000Z");
  const dueAt = nowMs - 2_000;
  const job = dueJob("manual-backoff", nowMs, dueAt);
  job.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt };
  job.state = {
    nextRunAtMs: dueAt,
    forcePreservedNextRunAtMs: dueAt,
    lastRunAtMs: nowMs - 3_000,
    lastDurationMs: 2_500,
    lastRunStatus: "error",
    consecutiveErrors: 1,
  };
  const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
  const state = await prepareJob(job, {
    cronEnabled: false,
    nowMs: () => nowMs,
    runIsolatedAgentJob,
  });

  await expect(run(state, job.id, "due")).resolves.toEqual({
    ok: true,
    ran: false,
    reason: "not-due",
  });
  expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });
  expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
  expect((await loadCronStore(state.deps.storePath)).jobs[0]?.state.nextRunAtMs).toBe(dueAt);
});

it("force-runs a due paced job without consuming its pending slot", async () => {
  const nowMs = Date.parse("2026-07-19T09:00:00.000Z");
  const dueSlot = nowMs - 1_000;
  const job = recurringJob("manual-paced-due-slot", nowMs, {
    schedule: { kind: "every", everyMs: 60_000, anchorMs: nowMs - 60_000 },
    state: { nextRunAtMs: dueSlot, pacedNextRunAtMs: dueSlot, startupCatchupAtMs: dueSlot },
  });
  job.pacing = { min: "15m", max: "4h" };
  const state = await prepareJob(job, {
    cronEnabled: false,
    nowMs: () => nowMs,
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
  });

  await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });

  const stored = state.store?.jobs.find((entry) => entry.id === job.id);
  const preserved = {
    nextRunAtMs: dueSlot,
    pacedNextRunAtMs: dueSlot,
    forcePreservedNextRunAtMs: dueSlot,
    startupCatchupAtMs: dueSlot,
  };
  expect(stored?.state).toMatchObject(preserved);

  const restarted = createCronRegressionState({
    cronEnabled: false,
    storePath: state.deps.storePath,
    nowMs: () => nowMs + 5_000,
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
  });
  await ensureLoaded(restarted);

  const reloaded = restarted.store?.jobs.find((entry) => entry.id === job.id);
  expect(reloaded?.state).toMatchObject(preserved);
});

it("applies timeoutSeconds to manual cron.run isolated executions", async () => {
  vi.useFakeTimers();
  try {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const job = recurringJob("manual-timeout", scheduledAt, {
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
    });
    const abortAwareRunner = createAbortAwareIsolatedRunner();
    const state = await prepareJob(job, {
      cronEnabled: false,
      runIsolatedAgentJob: abortAwareRunner.runIsolatedAgentJob,
    });

    const resultPromise = run(state, job.id, "force");
    await abortAwareRunner.waitForStart();
    await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10);
    const result = await resultPromise;
    expect(result).toEqual({ ok: true, ran: true });
    expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);

    const updated = state.store?.jobs.find((entry) => entry.id === job.id);
    expect(updated?.state.lastStatus).toBe("error");
    expect(updated?.state.lastError).toContain("timed out");
    expect(updated?.state.runningAtMs).toBeUndefined();
    expect(readCronRunRecordsForTests().find((entry) => entry.jobId === job.id)).toMatchObject({
      status: "timed_out",
      detail: { kind: "cron-run", status: "error" },
    });
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a queued quiet schedule event separate from its one terminal event", async () => {
  vi.useRealTimers();

  const dueAt = Date.parse("2026-02-06T10:05:02.000Z");
  const job = recurringJob("queued-quiet-trigger", dueAt, {
    schedule: { kind: "every", everyMs: 60_000, anchorMs: dueAt - 60_000 },
    trigger: { script: "return false" },
  });
  const terminal = terminalEvents(job.id, undefined, true);
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const state = await prepareJob(job, {
    cronConfig: { triggers: { enabled: true } },
    nowMs: () => dueAt,
    evaluateCronTrigger: vi.fn(async () => ({
      kind: "evaluated" as const,
      fire: false,
    })),
    runIsolatedAgentJob,
    onEvent: terminal.onEvent,
  });

  try {
    const runId = expectQueuedRunAck(await enqueueRun(state, job.id, "due"));
    await terminal.finished;
    await expect(waitForManualRun(state, runId, 5_000)).resolves.toBe(true);

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(terminal.events.map((event) => event.action)).toEqual([
      "started",
      "finished",
      "scheduled",
    ]);
    const finished = terminal.events.filter((event) => event.action === "finished");
    expectSingleEvent(finished, {
      jobId: job.id,
      runId,
      status: "skipped",
      error: "queued manual run skipped: trigger condition not met",
    });
  } finally {
    await Promise.allSettled(state.queuedManualRuns.values());
  }
});

it.each(["removed", "disabled"] as const)(
  "aborts and records a queued isolated job when it is %s",
  async (mutation) => {
    vi.useRealTimers();

    const dueAt = Date.parse("2026-02-06T10:05:04.000Z");
    const job = dueJob(`queued-${mutation}-manual`, dueAt);
    const reason = `Cron job ${mutation} by operator.`;

    const started = createDeferred<AbortSignal>();
    const releaseProvider = createDeferred();
    const providerExited = createDeferred();
    const events: CronEvent[] = [];
    const state = await prepareJob(job, {
      nowMs: () => dueAt,
      runIsolatedAgentJob: vi.fn(async ({ abortSignal, onExecutionStarted }) => {
        if (!abortSignal) {
          throw new Error("expected isolated cron abort signal");
        }
        onExecutionStarted?.();
        started.resolve(abortSignal);
        await Promise.race([releaseProvider.promise, waitForAbort(abortSignal)]);
        providerExited.resolve();
        return { status: "ok" as const, summary: "late provider result" };
      }),
      onEvent: (evt) => events.push(evt),
    });

    const runId = expectQueuedRunAck(await enqueueRun(state, job.id, "force"));
    const abortSignal = await started.promise;

    try {
      if (mutation === "removed") {
        await expect(remove(state, job.id)).resolves.toEqual({
          ok: true,
          removed: true,
          activeRunCancellationRequested: true,
        });
      } else {
        await update(state, job.id, { enabled: false });
      }

      expect(abortSignal.aborted).toBe(true);
      expect(abortSignal.reason).toBe(reason);
      await providerExited.promise;
      await expect(waitForManualRun(state, runId, 5_000)).resolves.toBe(true);

      const completedEvents = events.filter(
        (evt) => evt.action === "finished" && evt.runId === runId,
      );
      const expected = { jobId: job.id, status: "error" as const, error: reason };
      expectSingleEvent(completedEvents, expected);
      expectSingleEvent(
        readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(state.deps.storePath),
          jobId: job.id,
          runId,
        }).entries,
        expected,
      );
      expect(latestRunReceipt(state.deps.storePath, job.id)).toEqual({
        status: "error",
        error: reason,
      });
      const storedJob = state.store?.jobs.find((entry) => entry.id === job.id);
      if (mutation === "removed") {
        expect(storedJob).toBeUndefined();
      } else {
        expect(storedJob).toMatchObject({
          enabled: false,
          state: {
            lastStatus: "error",
            lastError: reason,
            runningAtMs: undefined,
          },
        });
      }
    } finally {
      releaseProvider.resolve();
      await Promise.allSettled(state.queuedManualRuns.values());
    }
  },
);

it("#102238 waits for a disabled run to abort before a re-enabled timer tick", async () => {
  const now = Date.parse("2026-07-09T12:00:00.000Z");
  const job = dueJob("disable-enable-timer", now, now - 60_000);

  const firstRunStarted = createDeferred<AbortSignal>();
  let dispatchCount = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const state = await prepareJob(job, {
    nowMs: () => now,
    runIsolatedAgentJob: vi.fn(async ({ abortSignal }) => {
      dispatchCount += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (dispatchCount === 1) {
        if (!abortSignal) {
          throw new Error("expected isolated cron abort signal");
        }
        firstRunStarted.resolve(abortSignal);
        await waitForAbort(abortSignal);
      }
      inFlight -= 1;
      return { status: "ok" as const, summary: "done" };
    }),
  });

  const firstRun = run(state, job.id, "force");
  const firstAbortSignal = await firstRunStarted.promise;
  expect(isCronJobActive(job.id)).toBe(true);

  await update(state, job.id, { enabled: false });
  expect(firstAbortSignal.aborted).toBe(true);
  await firstRun;
  await update(state, job.id, { enabled: true });

  await onTimer(state);

  expect(dispatchCount).toBe(2);
  expect(peakInFlight).toBe(1);
});

it("#104518 finalizes watcher-fired on-exit job: onexit-delete-ok", async () => {
  const nowMs = Date.now();
  const job = recurringJob("onexit-delete-ok", nowMs, {
    schedule: { kind: "on-exit", command: 'sh -c "exit 0"' },
    state: {},
  });
  job.deleteAfterRun = true;
  // The gateway watcher persists this disable before force-running the payload.
  job.enabled = false;
  const events: CronEvent[] = [];
  const state = await prepareJob(job, {
    cronEnabled: false,
    runIsolatedAgentJob: vi
      .fn()
      .mockResolvedValue({ status: "ok", summary: "ok", delivered: true }),
    onEvent: (event) => events.push(event),
  });
  await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });

  const memoryJob = state.store?.jobs.find((entry) => entry.id === job.id);
  const durableJob = (await loadCronStore(state.deps.storePath)).jobs.find(
    (entry) => entry.id === job.id,
  );
  expect(memoryJob).toBeUndefined();
  expect(durableJob).toBeUndefined();
  expect(events.map((event) => event.action)).toEqual(["started", "finished", "removed"]);
});
