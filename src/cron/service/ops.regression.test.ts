// Cron ops regression tests cover service operation regressions.
import { describe, expect, it, vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createCronRegressionState,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
} from "../../gateway/device-revocation.js";
import { resolveCronMutationCommitGuard } from "../../gateway/server-methods/cron-caller-scope.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  clearCommandLane,
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
import { CommandLane } from "../../process/lanes.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { mockCall } from "../../test-utils/mock-call-assertions.js";
import { isCronJobActive } from "../active-jobs.js";
import { createCronMutationCompletion } from "../mutation-completion.js";
import {
  readCronRunHistoryPageForTests,
  readCronRunRecordsForTests,
} from "../run-history.test-support.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { remove, update } from "./ops-mutations.js";
import { enqueueRun, run } from "./ops-run.js";
import type { CronEvent } from "./state.js";
import { ensureLoaded } from "./store.js";
import { onTimer } from "./timer.test-support.js";

const FAST_TIMEOUT_SECONDS = 1;
const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-ops-regressions-",
});

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

describe("cron service ops regressions", () => {
  it("transfers queued manual runs out of the released request root", async () => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const childLane = "cron-manual-admission-child";
    clearCommandLane(childLane);
    setCommandLaneConcurrency(childLane, 1);
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createDueIsolatedJob({
      id: "manual-admission-continuation",
      nowMs: now,
      nextRunAtMs: now,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const enterRunner = createDeferred();
    const runnerStarted = createDeferred();
    const finished = createDeferred();
    let terminalEvent: CronEvent | undefined;
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob: vi.fn(async () => {
        runnerStarted.resolve();
        await enterRunner.promise;
        expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
        await enqueueCommandInLane(childLane, async () => undefined);
        return { status: "ok" as const };
      }),
      onEvent: (event) => {
        if (event.jobId === job.id && event.action === "finished") {
          terminalEvent = event;
          finished.resolve();
        }
      },
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
      await finished.promise;
      await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0), { timeout: 5_000 });
      expect(terminalEvent).toMatchObject({ status: "ok" });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      requestRoot?.release();
      enterRunner.resolve();
      clearCommandLane(childLane);
      clearCommandLane(CommandLane.Cron);
      resetGatewayWorkAdmission();
    }
  });

  it("runs a manual run queued from an agent turn outside that turn's transcript lifecycle", async () => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    clearCommandLane(CommandLane.Cron);
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createDueIsolatedJob({
      id: "manual-from-agent-turn",
      nowMs: now,
      nextRunAtMs: now,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const callerSessionKey = "agent:main:main";
    const callerTurnEnded = createDeferred();
    const finished = createDeferred<CronEvent>();
    const reportWrites: string[] = [];
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob: vi.fn(async () => {
        await callerTurnEnded.promise;
        // A current-session report lands in the session that started the run.
        await runWithOwnedSessionTranscriptWrite({ sessionKey: callerSessionKey }, () => {
          reportWrites.push("report");
        });
        return { status: "ok" as const };
      }),
      onEvent: (event) => {
        if (event.jobId === job.id && event.action === "finished") {
          finished.resolve(event);
        }
      },
    });
    const callerTurn = createEmbeddedAttemptTranscriptLifecycle({ runId: "caller-turn" });

    try {
      await withOwnedSessionTranscriptWrites(
        {
          sessionKey: callerSessionKey,
          withTranscriptWrite: (write) => callerTurn.withTranscriptWrite(write),
        },
        async () => expectQueuedRunAck(await enqueueRun(state, job.id, "force")),
      );
      await callerTurn.dispose();
      callerTurnEnded.resolve();

      expect(await finished.promise).toMatchObject({ status: "ok" });
      expect(reportWrites).toEqual(["report"]);
    } finally {
      callerTurnEnded.resolve();
      clearCommandLane(CommandLane.Cron);
      resetGatewayWorkAdmission();
    }
  });

  it("rejects queueing when detached admission is already closed", async () => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createDueIsolatedJob({
      id: "manual-admission-closed",
      nowMs: now,
      nextRunAtMs: now,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const onEvent = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath: store.storePath,
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

  it("keeps an acknowledged manual reservation ahead of a later timer tick", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.now() - 1;
    const job = createIsolatedRegressionJob({
      id: "timer-overlap",
      name: "timer-overlap",
      scheduledAt: dueAt,
      schedule: { kind: "at", at: new Date(dueAt).toISOString() },
      payload: { kind: "agentTurn", message: "long task" },
      state: { nextRunAtMs: dueAt },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const blockerStarted = createDeferred();
    const releaseBlocker = createDeferred();
    const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
      blockerStarted.resolve();
      return await releaseBlocker.promise;
    });
    await blockerStarted.promise;

    let resolveRun:
      | ((value: { status: "ok" | "error" | "skipped"; summary?: string; error?: string }) => void)
      | undefined;
    const started = createDeferred();
    const finished = createDeferred();
    const events: CronEvent[] = [];
    const runIsolatedAgentJob = vi.fn(async () => {
      started.resolve();
      return await new Promise<{
        status: "ok" | "error" | "skipped";
        summary?: string;
        error?: string;
      }>((resolve) => {
        resolveRun = resolve;
      });
    });

    const state = createCronRegressionState({
      storePath: store.storePath,
      runIsolatedAgentJob,
      onEvent: (evt: CronEvent) => {
        events.push(evt);
        if (evt.jobId !== job.id) {
          return;
        }
        if (evt.action === "finished" && evt.status === "ok") {
          finished.resolve();
        }
      },
    });

    const ack = await enqueueRun(state, job.id, "force");
    const runId = expectQueuedRunAck(ack);

    await onTimer(state);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();

    releaseBlocker.resolve();
    await blocker;
    await started.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    resolveRun?.({ status: "ok", summary: "done" });
    await finished.promise;
    await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0), { timeout: 5_000 });
    expect(events.filter((event) => event.action === "finished")).toEqual([
      expect.objectContaining({
        jobId: job.id,
        action: "finished",
        status: "ok",
        runId,
      }),
    ]);
    clearCommandLane(CommandLane.Cron);
  });

  it("manual cron.run preserves unrelated due jobs but advances already-executed stale slots", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.now();
    const dueNextRunAtMs = nowMs - 1_000;
    const staleExecutedNextRunAtMs = nowMs - 2_000;

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        createIsolatedRegressionJob({
          id: "manual-target",
          name: "manual target",
          scheduledAt: nowMs,
          schedule: { kind: "at", at: new Date(nowMs + 3_600_000).toISOString() },
          payload: { kind: "agentTurn", message: "manual target" },
          state: { nextRunAtMs: nowMs + 3_600_000 },
        }),
        createIsolatedRegressionJob({
          id: "unrelated-due",
          name: "unrelated due",
          scheduledAt: nowMs,
          schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
          payload: { kind: "agentTurn", message: "unrelated due" },
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
        createIsolatedRegressionJob({
          id: "unrelated-stale-executed",
          name: "unrelated stale executed",
          scheduledAt: nowMs,
          schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
          payload: { kind: "agentTurn", message: "unrelated stale executed" },
          state: {
            nextRunAtMs: staleExecutedNextRunAtMs,
            lastRunAtMs: staleExecutedNextRunAtMs + 1,
          },
        }),
      ],
    });

    const state = createCronRegressionState({
      cronEnabled: false,
      storePath: store.storePath,
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    const runResult = await run(state, "manual-target", "force");
    expect(runResult).toEqual({ ok: true, ran: true });

    const jobs = state.store?.jobs ?? [];
    const unrelated = jobs.find((entry) => entry.id === "unrelated-due");
    const staleExecuted = jobs.find((entry) => entry.id === "unrelated-stale-executed");
    expect(unrelated?.state.nextRunAtMs).toBe(dueNextRunAtMs);
    expect((staleExecuted?.state.nextRunAtMs ?? 0) > nowMs).toBe(true);
  });

  it("force-runs a due paced job without consuming its pending slot", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.parse("2026-07-19T09:00:00.000Z");
    const dueSlot = nowMs - 1_000;
    const job = createIsolatedRegressionJob({
      id: "manual-paced-due-slot",
      name: "manual paced due slot",
      scheduledAt: nowMs,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: nowMs - 60_000 },
      payload: { kind: "agentTurn", message: "manual paced due slot" },
      state: { nextRunAtMs: dueSlot, pacedNextRunAtMs: dueSlot, startupCatchupAtMs: dueSlot },
    });
    job.pacing = { min: "15m", max: "4h" };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createCronRegressionState({
      cronEnabled: false,
      storePath: store.storePath,
      nowMs: () => nowMs,
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });

    const stored = state.store?.jobs.find((entry) => entry.id === job.id);
    expect(stored?.state.nextRunAtMs).toBe(dueSlot);
    expect(stored?.state.pacedNextRunAtMs).toBe(dueSlot);
    expect(stored?.state.forcePreservedNextRunAtMs).toBe(dueSlot);
    expect(stored?.state.startupCatchupAtMs).toBe(dueSlot);

    const restarted = createCronRegressionState({
      cronEnabled: false,
      storePath: store.storePath,
      nowMs: () => nowMs + 5_000,
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });
    await ensureLoaded(restarted);

    const reloaded = restarted.store?.jobs.find((entry) => entry.id === job.id);
    expect(reloaded?.state.nextRunAtMs).toBe(dueSlot);
    expect(reloaded?.state.pacedNextRunAtMs).toBe(dueSlot);
    expect(reloaded?.state.forcePreservedNextRunAtMs).toBe(dueSlot);
    expect(reloaded?.state.startupCatchupAtMs).toBe(dueSlot);
  });

  it("passes the rehydrated agentTurn payload message to isolated manual runs", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.now();
    const marker =
      "SERIALIZATION_PROBE: reply exactly with the marker token you received and nothing else.";
    const job = createIsolatedRegressionJob({
      id: "manual-payload-message",
      name: "manual payload message",
      scheduledAt: nowMs,
      schedule: { kind: "at", at: new Date(nowMs + 3_600_000).toISOString() },
      payload: { kind: "agentTurn", message: marker },
      state: { nextRunAtMs: nowMs + 3_600_000 },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "ok" });
    const state = createCronRegressionState({
      cronEnabled: false,
      storePath: store.storePath,
      runIsolatedAgentJob,
    });

    const runResult = await run(state, job.id, "force");

    expect(runResult).toEqual({ ok: true, ran: true });
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
    const [params] = mockCall(runIsolatedAgentJob, 0) as [{ message?: unknown }?];
    expect(params?.message).toBe(marker);
  });

  it("applies timeoutSeconds to manual cron.run isolated executions", async () => {
    vi.useFakeTimers();
    try {
      const store = opsRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const job = createIsolatedRegressionJob({
        id: "manual-timeout",
        name: "manual timeout",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt },
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        state: { nextRunAtMs: scheduledAt },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const abortAwareRunner = createAbortAwareIsolatedRunner();
      const state = createCronRegressionState({
        cronEnabled: false,
        storePath: store.storePath,
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

  it("#17554: run() clears stale runningAtMs and executes the job", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const staleRunningAtMs = now - 2 * 60 * 60 * 1000 - 1;

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        {
          id: "stale-running",
          name: "stale-running",
          enabled: true,
          createdAtMs: now - 3_600_000,
          updatedAtMs: now - 3_600_000,
          schedule: { kind: "at", at: new Date(now - 60_000).toISOString() },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "stale-running" },
          state: {
            runningAtMs: staleRunningAtMs,
            lastRunAtMs: now - 3_600_000,
            lastStatus: "ok",
            nextRunAtMs: now - 60_000,
          },
        },
      ],
    });

    const enqueueSystemEvent = vi.fn();
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
      enqueueSystemEvent,
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    const result = await run(state, "stale-running", "force");
    expect(result).toEqual({ ok: true, ran: true });
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = mockCall(enqueueSystemEvent, 0) as [string, { agentId?: unknown }?];
    expect(text).toBe("stale-running");
    expect(options?.agentId).toBe("main");
  });

  it("clears an orphaned queued reservation and executes the due job", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:01.000Z");
    const job = createDueIsolatedJob({
      id: "stale-queued",
      nowMs: now,
      nextRunAtMs: now - 60_000,
    });
    job.state.queuedAtMs = now - 2 * 60 * 60 * 1000 - 1;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "ok" });
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob,
    });

    await expect(run(state, job.id, "due")).resolves.toEqual({ ok: true, ran: true });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(
      state.store?.jobs.find((entry) => entry.id === job.id)?.state.queuedAtMs,
    ).toBeUndefined();
  });

  it("keeps a queued quiet schedule event separate from its one terminal event", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:02.000Z");
    const job = {
      ...createIsolatedRegressionJob({
        id: "queued-quiet-trigger",
        name: "queued quiet trigger",
        scheduledAt: dueAt,
        schedule: { kind: "every" as const, everyMs: 60_000, anchorMs: dueAt - 60_000 },
        payload: { kind: "agentTurn" as const, message: "watch" },
        state: { nextRunAtMs: dueAt },
      }),
      trigger: { script: "return false" },
    };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const terminal = createDeferred();
    const events: CronEvent[] = [];
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      cronConfig: { triggers: { enabled: true } },
      storePath: store.storePath,
      nowMs: () => dueAt,
      evaluateCronTrigger: vi.fn(async () => ({
        kind: "evaluated" as const,
        fire: false,
      })),
      runIsolatedAgentJob,
      onEvent: (event) => {
        events.push(structuredClone(event));
        if (event.action === "finished") {
          terminal.resolve();
        }
      },
    });

    try {
      const ack = await enqueueRun(state, job.id, "due");
      const runId = expectQueuedRunAck(ack);
      await terminal.promise;
      await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0), { timeout: 5_000 });

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(events.map((event) => event.action)).toEqual(["started", "scheduled", "finished"]);
      expect(events.filter((event) => event.action === "finished")).toEqual([
        expect.objectContaining({
          jobId: job.id,
          runId,
          status: "skipped",
          error: "queued manual run skipped: trigger condition not met",
        }),
      ]);
    } finally {
      clearCommandLane(CommandLane.Cron);
    }
  });

  it.each([
    {
      mutation: "removed",
      reason: "Cron job removed by operator.",
      mutate: async (state: ReturnType<typeof createCronRegressionState>, jobId: string) => {
        await expect(remove(state, jobId)).resolves.toEqual({
          ok: true,
          removed: true,
          activeRunCancellationRequested: true,
        });
      },
      expectRemoved: true,
    },
    {
      mutation: "disabled",
      reason: "Cron job disabled by operator.",
      mutate: async (state: ReturnType<typeof createCronRegressionState>, jobId: string) => {
        await update(state, jobId, { enabled: false });
      },
      expectRemoved: false,
    },
  ])("aborts and records a queued isolated job when it is $mutation", async (testCase) => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:04.000Z");
    const job = createDueIsolatedJob({
      id: `queued-${testCase.mutation}-manual`,
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const started = createDeferred<AbortSignal>();
    const releaseProvider = createDeferred();
    const providerExited = createDeferred();
    const events: CronEvent[] = [];
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => dueAt,
      runIsolatedAgentJob: vi.fn(async ({ abortSignal, onExecutionStarted }) => {
        if (!abortSignal) {
          throw new Error("expected isolated cron abort signal");
        }
        onExecutionStarted?.();
        started.resolve(abortSignal);
        await Promise.race([
          releaseProvider.promise,
          new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        providerExited.resolve();
        return { status: "ok" as const, summary: "late provider result" };
      }),
      onEvent: (evt) => events.push(evt),
    });

    const ack = await enqueueRun(state, job.id, "force");
    const runId = expectQueuedRunAck(ack);
    const abortSignal = await started.promise;

    try {
      await testCase.mutate(state, job.id);

      expect(abortSignal.aborted).toBe(true);
      expect(abortSignal.reason).toBe(testCase.reason);
      await providerExited.promise;
      await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0), { timeout: 5_000 });

      const terminalEvents = events.filter(
        (evt) => evt.action === "finished" && evt.runId === runId,
      );
      expect(terminalEvents).toEqual([
        expect.objectContaining({
          jobId: job.id,
          status: "error",
          error: testCase.reason,
        }),
      ]);
      expect(
        readCronRunHistoryPageForTests({
          storeKey: cronStoreKey(store.storePath),
          jobId: job.id,
          runId,
        }).entries,
      ).toEqual([
        expect.objectContaining({
          jobId: job.id,
          status: "error",
          error: testCase.reason,
        }),
      ]);
      expect(latestRunReceipt(store.storePath, job.id)).toEqual({
        status: "error",
        error: testCase.reason,
      });
      const storedJob = state.store?.jobs.find((entry) => entry.id === job.id);
      if (testCase.expectRemoved) {
        expect(storedJob).toBeUndefined();
      } else {
        expect(storedJob).toMatchObject({
          enabled: false,
          state: {
            lastStatus: "error",
            lastError: testCase.reason,
            runningAtMs: undefined,
          },
        });
      }
    } finally {
      releaseProvider.resolve();
      await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0), { timeout: 5_000 });
      clearCommandLane(CommandLane.Cron);
    }
  });

  it("#102238 waits for a disabled run to abort before a re-enabled timer tick", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-07-09T12:00:00.000Z");
    const job = createDueIsolatedJob({
      id: "disable-enable-timer",
      nowMs: now,
      nextRunAtMs: now - 60_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const firstRunStarted = createDeferred<AbortSignal>();
    let dispatchCount = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const state = createCronRegressionState({
      storePath: store.storePath,
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
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
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
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.now();
    const job = createIsolatedRegressionJob({
      id: "onexit-delete-ok",
      name: "onexit-delete-ok",
      scheduledAt: nowMs,
      schedule: { kind: "on-exit", command: 'sh -c "exit 0"' },
      payload: { kind: "agentTurn", message: "post-exit payload" },
      state: {},
    });
    job.deleteAfterRun = true;
    // The gateway watcher persists this disable before force-running the payload.
    job.enabled = false;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const events: CronEvent[] = [];
    const state = createCronRegressionState({
      cronEnabled: false,
      storePath: store.storePath,
      runIsolatedAgentJob: vi
        .fn()
        .mockResolvedValue({ status: "ok", summary: "ok", delivered: true }),
      onEvent: (event) => events.push(event),
    });
    await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });

    const memoryJob = state.store?.jobs.find((entry) => entry.id === job.id);
    const durableJob = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(memoryJob).toBeUndefined();
    expect(durableJob).toBeUndefined();
    expect(events.map((event) => event.action)).toEqual(["started", "finished", "removed"]);
  });
});
