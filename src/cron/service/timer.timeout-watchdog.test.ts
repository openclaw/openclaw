import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createIsolatedRegressionJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import {
  clearCronJobActive,
  markCronJobActive,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import { readCronRunRecordsForTests } from "../run-history.test-support.js";
import { saveCronStore } from "../store.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import type { CronJob } from "../types.js";
import { getSuspensionVisibleCronTaskRunCount } from "./active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "./active-run-cancellation.test-support.js";
import { stop } from "./ops-lifecycle.js";
import type { CronServiceDeps, CronServiceState } from "./state.js";
import { executeJobCoreWithTimeout } from "./timer-job-runner.js";
import { runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const SCHEDULED_AT = Date.parse("2026-05-10T09:00:00.000Z");
const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timeout-watchdog-",
  baseTimeIso: new Date(SCHEDULED_AT).toISOString(),
});
type RunnerArgs = Parameters<CronServiceDeps["runIsolatedAgentJob"]>[0];

function dueJob(id: string, overrides?: Partial<CronJob>): CronJob {
  return {
    ...createIsolatedRegressionJob({
      id,
      name: id,
      scheduledAt: SCHEDULED_AT,
      schedule: { kind: "at", at: new Date(SCHEDULED_AT).toISOString() },
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: 1_200 },
      state: { nextRunAtMs: SCHEDULED_AT },
    }),
    ...overrides,
  };
}

async function fixture(
  job: CronJob,
  deps: Partial<Parameters<typeof createCronRegressionState>[0]>,
) {
  const { storePath } = fixtures.makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  let now = SCHEDULED_AT;
  const state = createCronRegressionState({
    storePath,
    nowMs: () => now,
    runIsolatedAgentJob: vi.fn(),
    ...deps,
  });
  return {
    state,
    advance: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      now += ms;
    },
  };
}

function requireJob(state: CronServiceState, id: string) {
  const job = state.store?.jobs.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`expected cron job ${id}`);
  }
  return job;
}

function pendingRunner(report?: (args: RunnerArgs) => void) {
  const started = createDeferred<AbortSignal | undefined>();
  const result = createDeferred<{ status: "ok"; summary: string }>();
  const run = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async (args) => {
    report?.(args);
    started.resolve(args.abortSignal);
    return await result.promise;
  });
  return { run, started, result };
}

async function drain(...runs: Promise<unknown>[]) {
  await Promise.allSettled(runs);
  await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
}

describe("cron execution watchdogs", () => {
  it("keeps timed-out cron runs from being overwritten by late cancellation", async () => {
    resetActiveCronTaskRunsForTests();
    const job = dueJob("late-cancel-after-timeout", {
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: 1 },
    });
    const runner = pendingRunner(({ onExecutionStarted }) =>
      onExecutionStarted?.({
        jobId: job.id,
        phase: "tool_execution_started",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        sessionId: "sess-attrib",
        sessionKey: "key-attrib",
      }),
    );
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const cleanupTimedOutAgentRun = vi.fn(async () => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });
    const { state, advance } = await fixture(job, {
      cleanupTimedOutAgentRun,
      runIsolatedAgentJob: runner.run,
    });
    const timer = onTimer(state);
    try {
      await runner.started.promise;
      await advance(1_010);
      await cleanupStarted.promise;
      const receipt = inspectActiveCronRunReceipt({
        storePath: state.deps.storePath,
        jobId: job.id,
      });
      if (!receipt) {
        throw new Error("Expected an admitted cron receipt");
      }
      const runId = `cron:${job.id}:${receipt.startedAtMs}:${receipt.receiptId}`;
      requestActiveCronJobCancellation(job.id, "Cancelled by operator.");
      expect(readCronRunRecordsForTests(job.id)).toEqual([]);
      releaseCleanup.resolve();
      await timer;
      const record = readCronRunRecordsForTests(job.id).find((entry) => entry.runId === runId);
      expect(cleanupTimedOutAgentRun).toHaveBeenCalledOnce();
      expect(record?.status).toBe("timed_out");
      expect(record?.error).toContain("timed out");
      expect(requireJob(state, job.id)).toMatchObject({ enabled: true });
      expect(requireJob(state, job.id).state.nextRunAtMs).toBeGreaterThan(SCHEDULED_AT);
      expect(requireJob(state, job.id).state.autoDisabled).toBeUndefined();
      expect(requireJob(state, job.id).state.lastErrorReason).toBe("timeout");
      expect(record?.sessionKey).toBe("key-attrib");
      expect(record?.detail).toMatchObject({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        sessionId: "sess-attrib",
      });
    } finally {
      stop(state);
      runner.result.resolve({ status: "ok", summary: "done" });
      releaseCleanup.resolve();
      await drain(timer, runner.result.promise, releaseCleanup.promise);
      resetActiveCronTaskRunsForTests();
    }
  });

  it("keeps resolved provider/model/session on cancellation rows (#95873)", async () => {
    resetActiveCronTaskRunsForTests();
    const job = dueJob("cancel-attribution", {
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0 },
    });
    const { storePath } = fixtures.makeStorePath();
    const activeJobMarker = markCronJobActive(job.id);
    const entered = createDeferred();
    const release = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronRegressionState({
      storePath,
      nowMs: () => SCHEDULED_AT,
      runIsolatedAgentJob: vi.fn(async ({ onExecutionStarted }) => {
        onExecutionStarted?.({
          jobId: job.id,
          phase: "tool_execution_started",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          sessionId: "sess-attrib",
          sessionKey: "key-attrib",
        });
        entered.resolve();
        return await release.promise;
      }),
    });
    const resultPromise = executeJobCoreWithTimeout(state, job, {
      activeJobMarker,
      runId: `cron:${job.id}:${SCHEDULED_AT}`,
    });
    try {
      await entered.promise;
      requestActiveCronJobCancellation(job.id, "Cancelled by operator.");
      const result = await resultPromise;
      expect(result.status).toBe("error");
      expect(result.error).toBe("Cancelled by operator.");
      expect(result.provider).toBe("deepseek");
      expect(result.model).toBe("deepseek-v4-pro");
      expect(result.sessionId).toBe("sess-attrib");
      expect(result.sessionKey).toBe("key-attrib");
    } finally {
      stop(state);
      release.resolve({ status: "ok", summary: "done" });
      await drain(resultPromise, release.promise);
      clearCronJobActive(job.id, activeJobMarker);
      resetActiveCronTaskRunsForTests();
    }
  });

  it("notifies setup timeout after startup catch-up finalization", async () => {
    const job = dueJob("startup-setup-timeout", {
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: 120 },
    });
    const runner = pendingRunner();
    const onIsolatedAgentSetupTimeout = vi.fn();
    const { state, advance } = await fixture(job, {
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: runner.run,
    });
    const catchup = runMissedJobs(state);
    try {
      const signal = await runner.started.promise;
      await advance(60_100);
      await catchup;
      expect(signal?.aborted).toBe(true);
      expect(requireJob(state, job.id).state.lastStatus).toBe("error");
      expect(requireJob(state, job.id).state.lastError).toContain(
        "setup timed out before runner start",
      );
      expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledWith({
        job: expect.objectContaining({ id: job.id }),
        error: expect.stringContaining("setup timed out before runner start"),
        timeoutMs: 60_000,
      });
    } finally {
      stop(state);
      runner.result.resolve({ status: "ok", summary: "done" });
      await drain(catchup, runner.result.promise);
    }
  });

  it.each(["heartbeat"] as const)(
    "restarts the %s watchdog from the effective heartbeat timeout at handoff",
    async (kind) => {
      const job = dueJob(`heartbeat-handoff-${kind}`, {
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "heartbeat" },
        agentId: "   ",
        sessionKey: "agent:ops:main",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: SCHEDULED_AT - 60_000 },
      });
      const started = createDeferred<AbortSignal | undefined>();
      const resolveHeartbeatTimeoutMs = vi.fn(() => 15 * 60_000);
      const requestHeartbeatAndWait = vi.fn<
        NonNullable<CronServiceDeps["requestHeartbeatAndWait"]>
      >(async (_wake, { abortSignal, onAttemptStarted }) => {
        onAttemptStarted?.();
        started.resolve(abortSignal);
        await new Promise<void>((resolve) => {
          if (abortSignal?.aborted) {
            resolve();
          } else {
            abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        return { status: "failed", reason: "aborted" };
      });
      const { state, advance } = await fixture(job, {
        nowMs: Date.now,
        defaultAgentId: "main",
        resolveHeartbeatTimeoutMs,
        requestHeartbeatAndWait,
      });
      const timer = onTimer(state);
      let settled = false;
      void timer.then(() => {
        settled = true;
      });
      const signal = await started.promise;
      await advance(10 * 60_000 + 1);
      expect(signal?.aborted).toBe(false);
      expect(settled).toBe(false);
      await advance(5 * 60_000);
      await timer;
      expect(signal?.aborted).toBe(true);
      expect(settled).toBe(true);
      expect(resolveHeartbeatTimeoutMs).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ source: "interval", intent: "scheduled", agentId: "ops" }),
      );
      expect(requireJob(state, job.id).state.lastError).toContain("job execution timed out");
    },
  );

  it("does not spend setup or execution timeout while waiting for cron-nested admission (#41783)", async () => {
    const job = dueJob("isolated-setup-timeout-lane-wait", {
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: 1 },
    });
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = enqueueCommandInLane(CommandLane.CronNested, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const onIsolatedAgentSetupTimeout = vi.fn();
    const { state, advance } = await fixture(job, {
      cleanupTimedOutAgentRun: vi.fn(async () => {}),
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: vi.fn(async ({ onLaneWait, onExecutionStarted }) => {
        onLaneWait?.({ waiting: true });
        return await enqueueCommandInLane(CommandLane.CronNested, async () => {
          onLaneWait?.({ waiting: false });
          onExecutionStarted?.();
          return { status: "ok" as const, summary: "lane released" };
        });
      }),
    });
    const timer = onTimer(state);
    let settled = false;
    void timer.then(() => {
      settled = true;
    });
    try {
      await advance(60_100);
      expect(settled).toBe(false);
      expect(onIsolatedAgentSetupTimeout).not.toHaveBeenCalled();
      release.resolve();
      await blocker;
      await timer;
      expect(requireJob(state, job.id).state.lastStatus).toBe("ok");
      expect(requireJob(state, job.id).state.lastError).toBeUndefined();
    } finally {
      release.resolve();
      await blocker;
      await timer;
    }
  });

  it("gives setup progress the full configured timeout and cleans up an abort-ignoring runner (#93912, #29774)", async () => {
    const job = dueJob("isolated-pre-model-timeout");
    const execution = {
      jobId: job.id,
      agentId: "main",
      sessionId: "cron-run-session",
      sessionKey: `agent:main:cron:${job.id}:run:cron-run-session`,
    };
    const runner = pendingRunner(({ onExecutionStarted, onExecutionPhase }) => {
      onExecutionStarted?.({ ...execution, phase: "runner_entered" });
      for (const phase of [
        "workspace",
        "runtime_plugins",
        "before_agent_reply",
        "runtime_plugins",
        "model_resolution",
        "auth",
        "context_engine",
      ] as const) {
        onExecutionPhase?.({ ...execution, phase });
      }
    });
    const cleanupTimedOutAgentRun = vi.fn<NonNullable<CronServiceDeps["cleanupTimedOutAgentRun"]>>(
      async () => {},
    );
    const onIsolatedAgentSetupTimeout = vi.fn();
    const { state, advance } = await fixture(job, {
      cleanupTimedOutAgentRun,
      onIsolatedAgentSetupTimeout,
      runIsolatedAgentJob: runner.run,
    });
    const timer = onTimer(state);
    const signal = await runner.started.promise;
    await advance(60_100);
    expect(signal?.aborted).toBe(false);
    expect(cleanupTimedOutAgentRun).not.toHaveBeenCalled();
    await advance(539_900);
    expect(signal?.aborted).toBe(false);
    expect(cleanupTimedOutAgentRun).not.toHaveBeenCalled();
    await advance(600_000);
    await timer;
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("job execution timed out"),
    });
    expect(requireJob(state, job.id).state.lastStatus).toBe("error");
    expect(requireJob(state, job.id).state.lastError).toContain("job execution timed out");
    expect(requireJob(state, job.id).state.lastError).toContain("context-engine");
    expect(cleanupTimedOutAgentRun).toHaveBeenCalledExactlyOnceWith({
      job: expect.objectContaining({ id: job.id }),
      timeoutMs: 1_200_000,
      execution: { ...execution, phase: "context_engine" },
    });
    expect(onIsolatedAgentSetupTimeout).not.toHaveBeenCalled();
  });

  it("re-arms the pre-execution watchdog when a fallback runner returns to setup (#82811)", async () => {
    const job = dueJob("isolated-before-agent-reply-unhandled", {
      name: "before agent reply unhandled regression",
      delivery: { mode: "announce", channel: "telegram", to: "19098680", bestEffort: true },
      failureAlert: { after: 1, mode: "announce", channel: "telegram", to: "12345" },
    });
    const runner = pendingRunner(({ onExecutionStarted, onExecutionPhase }) => {
      onExecutionStarted?.({ jobId: job.id, phase: "runner_entered" });
      onExecutionPhase?.({ jobId: job.id, phase: "before_agent_reply" });
      onExecutionStarted?.({
        jobId: job.id,
        phase: "runner_entered",
        isFallback: true,
        provider: "fallback-provider",
        model: "fallback-model",
      });
      onExecutionPhase?.({ jobId: job.id, phase: "runtime_plugins" });
    });
    const cleanupTimedOutAgentRun = vi.fn(async () => {});
    const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
      async () => {},
    );
    const { state, advance } = await fixture(job, {
      cleanupTimedOutAgentRun,
      sendCronFailureAlert,
      runIsolatedAgentJob: runner.run,
    });
    const timer = onTimer(state);
    const signal = await runner.started.promise;
    await advance(60_100);
    await timer;
    const diagnostic =
      "cron: isolated agent run stalled before execution start (last phase: runtime-plugins)";
    const result = requireJob(state, job.id);
    expect(signal?.aborted).toBe(true);
    expect(result.state.lastStatus).toBe("error");
    expect(result.state.lastError).toBe(diagnostic);
    expect(result.state.lastDiagnosticSummary).toBe(diagnostic);
    expect(result.state.lastDiagnostics).toEqual({
      summary: diagnostic,
      entries: [{ source: "cron-setup", severity: "error", message: diagnostic, ts: SCHEDULED_AT }],
    });
    expect(cleanupTimedOutAgentRun).toHaveBeenCalledOnce();
    expect(sendCronFailureAlert).toHaveBeenCalledExactlyOnceWith({
      job: expect.objectContaining({ id: job.id }),
      routing: { defaultAgentId: "main" },
      payload: {
        text: 'Automation "before agent reply unhandled regression" failed 1 times\nCause: timeout',
      },
      runAtMs: expect.any(Number),
      channel: "telegram",
      to: "12345",
      mode: "announce",
      accountId: undefined,
      threadId: undefined,
      inheritSessionThread: false,
      onDeliverySettled: expect.any(Function),
    });
  });

  it("disables the outer watchdog for an unlimited main system-event heartbeat", async () => {
    const job = dueJob("unlimited-systemEvent", {
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "check heartbeat work" },
    });
    const started = createDeferred();
    const release = createDeferred();
    const { state, advance } = await fixture(job, {
      nowMs: Date.now,
      defaultAgentId: "main",
      resolveHeartbeatTimeoutMs: vi.fn(() => undefined),
      requestHeartbeatAndWait: vi.fn(async (_wake, { onQueued, onAttemptStarted }) => {
        onQueued?.();
        onAttemptStarted?.();
        started.resolve();
        await release.promise;
        return { status: "ran" as const, durationMs: 1 };
      }),
    });
    const timer = onTimer(state);
    let settled = false;
    void timer.then(() => {
      settled = true;
    });
    try {
      await started.promise;
      await advance(20 * 60_000);
      expect(settled).toBe(false);
      release.resolve();
      await timer;
      expect(requireJob(state, job.id).state.lastStatus).toBe("ok");
    } finally {
      release.resolve();
      await timer;
    }
  });

  it("keeps the cron deadline while a heartbeat-backed trigger is still evaluating", async () => {
    const job = dueJob("heartbeat-trigger-watchdog", {
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "check heartbeat work" },
      schedule: { kind: "every", everyMs: 60_000, anchorMs: SCHEDULED_AT - 60_000 },
      trigger: { script: "return { fire: true };" },
    });
    const started = createDeferred();
    const resolveHeartbeatTimeoutMs = vi.fn(() => 15 * 60_000);
    const { state, advance } = await fixture(job, {
      nowMs: Date.now,
      defaultAgentId: "main",
      resolveHeartbeatTimeoutMs,
      requestHeartbeatAndWait: vi.fn(async () => ({ status: "ran" as const, durationMs: 1 })),
      evaluateCronTrigger: vi.fn(async () => {
        started.resolve();
        return await new Promise<never>(() => {});
      }),
    });
    const timer = onTimer(state);
    await started.promise;
    await advance(10 * 60_000 + 1);
    await timer;
    expect(resolveHeartbeatTimeoutMs).not.toHaveBeenCalled();
    expect(state.deps.requestHeartbeatAndWait).not.toHaveBeenCalled();
    expect(requireJob(state, job.id).state.lastError).toContain("job execution timed out");
  });
});
