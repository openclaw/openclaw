import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createIsolatedRegressionJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
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
import { onTimer, runMissedJobs } from "./timer.test-support.js";

const SCHEDULED_AT = Date.parse("2026-05-10T09:00:00.000Z");
const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timeout-watchdog-",
  baseTimeIso: new Date(SCHEDULED_AT).toISOString(),
});
type RunnerArgs = Parameters<CronServiceDeps["runIsolatedAgentJob"]>[0];
const agentIdentity = {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  sessionId: "sess-attrib",
  sessionKey: "key-attrib",
} as const;
const done = { status: "ok", summary: "done" } as const;
type FixtureDeps = Partial<Parameters<typeof createCronRegressionState>[0]>;

function attribution(jobId: string) {
  return { jobId, phase: "tool_execution_started" as const, ...agentIdentity };
}

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

function agentJob(id: string, timeoutSeconds: number) {
  return dueJob(id, { payload: { kind: "agentTurn", message: "work", timeoutSeconds } });
}

function heartbeatJob(id: string, overrides: Partial<CronJob> = {}) {
  return dueJob(id, {
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "check heartbeat work" },
    schedule: { kind: "every", everyMs: 60_000, anchorMs: SCHEDULED_AT - 60_000 },
    ...overrides,
  });
}

async function fixture(job: CronJob, deps: FixtureDeps) {
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
    jobState: () => requireJob(state, job.id).state,
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

it("does not spend a main-session execution deadline waiting for event adoption", async () => {
  const { storePath } = fixtures.makeStorePath();
  const queued = createDeferred();
  const adoption = createDeferred();
  const state = createCronRegressionState({
    storePath,
    runSessionEvent: async ({ onLaneWait, onExecutionStarted }) => {
      onLaneWait?.({ waiting: true });
      queued.resolve();
      await adoption.promise;
      onLaneWait?.({ waiting: false });
      onExecutionStarted?.();
      return { status: "ok" };
    },
    runIsolatedAgentJob: vi.fn(),
  });
  const settled = vi.fn();
  const running = executeJobCoreWithTimeout(
    state,
    heartbeatJob("deferred-adoption", { wakeMode: "next-heartbeat" }),
  ).then((result) => {
    settled();
    return result;
  });
  try {
    await queued.promise;
    // Controller lane admission can exceed Cron's ten-minute execution deadline.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(settled).not.toHaveBeenCalled();
    adoption.resolve();
    await expect(running).resolves.toMatchObject({ status: "ok" });
  } finally {
    adoption.resolve();
    await drain(running);
  }
});

it("keeps timed-out cron runs from being overwritten by late cancellation", async () => {
  resetActiveCronTaskRunsForTests();
  const job = agentJob("late-cancel-after-timeout", 1);
  const runner = pendingRunner(({ onExecutionStarted }) =>
    onExecutionStarted?.(attribution(job.id)),
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
    expect(record).toMatchObject({
      status: "timed_out",
      sessionKey: "key-attrib",
      detail: { provider: "deepseek", model: "deepseek-v4-pro", sessionId: "sess-attrib" },
    });
    expect(record?.error).toContain("timed out");
    expect(requireJob(state, job.id)).toMatchObject({
      enabled: true,
      state: { lastErrorReason: "timeout" },
    });
    expect(requireJob(state, job.id).state.autoDisabled).toBeUndefined();
    expect(requireJob(state, job.id).state.nextRunAtMs).toBeGreaterThan(SCHEDULED_AT);
  } finally {
    stop(state);
    runner.result.resolve(done);
    releaseCleanup.resolve();
    await drain(timer, runner.result.promise, releaseCleanup.promise);
    resetActiveCronTaskRunsForTests();
  }
});

it("returns cancellation attribution before the core finishes its owned cleanup (#95873)", async () => {
  resetActiveCronTaskRunsForTests();
  const job = agentJob("cancel-attribution", 0);
  const { storePath } = fixtures.makeStorePath();
  const activeJobMarker = markCronJobActive(job.id);
  const entered = createDeferred();
  const release = createDeferred<{ status: "ok"; summary: string }>();
  const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(
    async ({ onExecutionStarted }) => {
      onExecutionStarted?.(attribution(job.id));
      entered.resolve();
      const result = await release.promise;
      return await trackAsyncWork(() => result);
    },
  );
  const state = createCronRegressionState({
    storePath,
    nowMs: () => SCHEDULED_AT,
    runIsolatedAgentJob,
  });
  const work = new AsyncWorkScope();
  const resultPromise = work.run(() =>
    executeJobCoreWithTimeout(state, job, {
      activeJobMarker,
      runId: `cron:${job.id}:${SCHEDULED_AT}`,
    }),
  );
  try {
    await entered.promise;
    requestActiveCronJobCancellation(job.id, "Cancelled by operator.");
    const result = await resultPromise;
    expect(result).toMatchObject({
      status: "error",
      error: "Cancelled by operator.",
      ...agentIdentity,
    });
    const drained = work.drain();
    release.resolve(done);
    await expect(runIsolatedAgentJob.mock.results[0]?.value).resolves.toEqual({
      status: "ok",
      summary: "done",
    });
    await drained;
  } finally {
    stop(state);
    release.resolve(done);
    await drain(resultPromise, release.promise);
    await work.drain();
    clearCronJobActive(job.id, activeJobMarker);
    resetActiveCronTaskRunsForTests();
  }
});

it("notifies setup timeout after startup catch-up finalization", async () => {
  const job = agentJob("startup-setup-timeout", 120);
  const runner = pendingRunner();
  const onIsolatedAgentSetupTimeout = vi.fn();
  const { state, advance, jobState } = await fixture(job, {
    onIsolatedAgentSetupTimeout,
    runIsolatedAgentJob: runner.run,
  });
  const catchup = runMissedJobs(state);
  try {
    const signal = await runner.started.promise;
    await advance(60_100);
    await catchup;
    expect(signal?.aborted).toBe(true);
    expect(jobState()).toMatchObject({
      lastStatus: "error",
      lastError: expect.stringContaining("setup timed out before runner start"),
    });
    expect(onIsolatedAgentSetupTimeout).toHaveBeenCalledWith({
      job: expect.objectContaining({ id: job.id }),
      error: expect.stringContaining("setup timed out before runner start"),
      timeoutMs: 60_000,
    });
  } finally {
    stop(state);
    runner.result.resolve(done);
    await drain(catchup, runner.result.promise);
  }
});

it.each(["finite", "unlimited", "trigger evaluating"] as const)(
  "keeps the correct execution deadline: %s",
  async (mode) => {
    const finite = mode === "finite";
    const unlimited = mode === "unlimited";
    const job =
      finite || unlimited
        ? dueJob(`session-deadline-${mode}`, {
            agentId: "ops",
            sessionKey: "agent:ops:main",
            sessionTarget: "main",
            wakeMode: "now",
            payload: {
              kind: "agentTurn",
              message: "check scheduled work",
              timeoutSeconds: finite ? 15 * 60 : 0,
            },
          })
        : heartbeatJob("session-trigger-watchdog", {
            trigger: { script: "return { fire: true };" },
          });
    const started = createDeferred<AbortSignal | undefined>();
    const release = createDeferred();
    const resolveHeartbeatTimeoutMs = vi.fn();
    const requestHeartbeatAndWait =
      vi.fn<NonNullable<CronServiceDeps["requestHeartbeatAndWait"]>>();
    const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(
      async ({ abortSignal, onExecutionStarted }) => {
        onExecutionStarted?.({ jobId: job.id, phase: "model_call_started" });
        started.resolve(abortSignal);
        if (unlimited) {
          await release.promise;
        } else {
          await new Promise<void>((resolve) => {
            if (abortSignal?.aborted) {
              resolve();
            } else {
              abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            }
          });
        }
        return finite ? { status: "error", error: "aborted" } : { status: "ok" };
      },
    );
    const { state, advance } = await fixture(job, {
      nowMs: Date.now,
      defaultAgentId: "main",
      resolveHeartbeatTimeoutMs,
      requestHeartbeatAndWait,
      runSessionEvent,
      ...(!finite && !unlimited
        ? {
            evaluateCronTrigger: vi.fn(async () => {
              started.resolve(undefined);
              return await new Promise<never>(() => {});
            }),
          }
        : {}),
    });
    const timer = onTimer(state);
    let settled = false;
    void timer.then(() => {
      settled = true;
    });
    try {
      const signal = await started.promise;
      await advance(unlimited ? 20 * 60_000 : 10 * 60_000 + 1);
      if (finite) {
        expect(signal?.aborted).toBe(false);
        expect(settled).toBe(false);
        await advance(5 * 60_000);
        await timer;
        expect(signal?.aborted).toBe(true);
        expect(settled).toBe(true);
        expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            job: expect.objectContaining({ agentId: "ops", sessionKey: "agent:ops:main" }),
          }),
        );
        expect(resolveHeartbeatTimeoutMs).not.toHaveBeenCalled();
        expect(requestHeartbeatAndWait).not.toHaveBeenCalled();
      } else if (unlimited) {
        expect(settled).toBe(false);
        release.resolve();
        await timer;
        expect(requireJob(state, job.id).state.lastStatus).toBe("ok");
        return;
      } else {
        await timer;
        expect(resolveHeartbeatTimeoutMs).not.toHaveBeenCalled();
        expect(requestHeartbeatAndWait).not.toHaveBeenCalled();
        expect(runSessionEvent).not.toHaveBeenCalled();
      }
      expect(requireJob(state, job.id).state.lastError).toContain(
        finite ? "job execution timed out" : "setup timed out before runner start",
      );
    } finally {
      if (unlimited) {
        release.resolve();
        await timer;
      }
    }
  },
);

it("does not spend setup or execution timeout while waiting for cron-nested admission (#41783)", async () => {
  const job = agentJob("isolated-setup-timeout-lane-wait", 1);
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
  for (const elapsed of [60_100, 539_900]) {
    await advance(elapsed);
    expect(signal?.aborted).toBe(false);
    expect(cleanupTimedOutAgentRun).not.toHaveBeenCalled();
  }
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
