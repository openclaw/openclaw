import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createIsolatedRegressionJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import {
  clearCronJobActive,
  markCronJobActive,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import { runCronCommandJob } from "../command-runner.js";
import { isCronTimeoutErrorText } from "../execution-error-constants.js";
import * as proactiveReceipts from "../proactive-job-receipt.js";
import type { CronAgentExecutionPhase, CronAgentExecutionStarted } from "../types.js";
import {
  getSuspensionVisibleCronTaskRunCount,
  waitForActiveCronTaskRuns,
} from "./active-run-cancellation.js";
import { CRON_AGENT_SETUP_WATCHDOG_MS, createCronAgentWatchdog } from "./agent-watchdog.js";
import { preExecutionTimeoutErrorMessage } from "./execution-errors.js";
import type { CronServiceDeps } from "./state.js";
import { executeJobCoreWithTimeout } from "./timer-job-runner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const expectDrained = () =>
  expect(waitForActiveCronTaskRuns(1_000)).resolves.toEqual({ drained: true, active: 0 });

function commandFixture(
  id: string,
  argv = ["unused"],
  runner: NonNullable<CronServiceDeps["runCommandJob"]> = runCronCommandJob,
) {
  const job = createIsolatedRegressionJob({
    id,
    name: id,
    scheduledAt: Date.now(),
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "command", argv, timeoutSeconds: 1 },
  });
  const sendCronWebhook = vi.fn();
  const commandStarted = createDeferred();
  let command: ReturnType<typeof runner> | undefined;
  const state = createCronRegressionState({
    storePath: path.join(tempDirs.make("cron-command-"), "jobs.json"),
    runIsolatedAgentJob: vi.fn(),
    runCommandJob: (params) => {
      command = runner(params);
      commandStarted.resolve();
      return command;
    },
    sendCronWebhook,
  });
  return { job, state, sendCronWebhook, started: commandStarted.promise, settle: () => command };
}

describe("scheduled command timeouts", () => {
  it.each(["deadline", "operator cancellation"] as const)(
    "settles a real command after %s without late delivery",
    async (interruption) => {
      const { job, state, sendCronWebhook, started, settle } = commandFixture("command-timeout", [
        process.execPath,
        "-e",
        "const fs = require('node:fs'); fs.writeSync(1, 'synthetic progress pid=' + process.pid + '\\n'); fs.writeSync(2, 'synthetic stderr\\n'); setInterval(() => {}, 1000)",
      ]);
      job.delivery = { mode: "webhook", to: "https://example.com/automation" };
      const activeJobMarker = markCronJobActive(job.id);
      try {
        const run = executeJobCoreWithTimeout(state, job, { runId: job.id, activeJobMarker });
        if (interruption === "operator cancellation") {
          await awaitGateBeforeSettlement(
            started,
            run,
            "Scheduled command settled before entering the command runner",
          );
          requestActiveCronJobCancellation(job.id, "Cancelled by operator.");
        }
        const result = await run;
        expect(sendCronWebhook).not.toHaveBeenCalled();
        if (interruption === "operator cancellation") {
          expect(result).toMatchObject({
            status: "error",
            error: "Cancelled by operator.",
          });
          expect(result.failureNotificationDetail).toBeUndefined();
          return;
        }
        expect(result).toMatchObject({
          status: "error",
          error: "command timed out",
          errorClassification: { kind: "reason", reason: "timeout" },
          failureNotificationDetail: { kind: "command-timeout", mode: "wall-clock" },
          delivered: false,
        });
        expect(result.diagnostics?.entries).toContainEqual(
          expect.objectContaining({ source: "exec", severity: "error" }),
        );
        expect(result.summary).toContain("synthetic progress");
        expect(result.summary).toContain("synthetic stderr");
        const pid = Number(result.summary?.match(/pid=(\d+)/)?.[1]);
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(isPidAlive(pid)).toBe(false);
      } finally {
        try {
          await settle();
          await expectDrained();
        } finally {
          clearCronJobActive(job.id, activeJobMarker);
        }
      }
    },
  );

  it.each(["timeout", "revoked"] as const)(
    "preserves command timeout and live authority through delayed preflight: %s",
    async (completion) => {
      vi.useFakeTimers();
      const preflightStarted = createDeferred();
      const releasePreflight = createDeferred();
      const originalRead = proactiveReceipts.readDefaultProactiveJobReceiptsByKeyAsync;
      const readReceipt = vi
        .spyOn(proactiveReceipts, "readDefaultProactiveJobReceiptsByKeyAsync")
        .mockImplementationOnce(async (...args) => {
          preflightStarted.resolve();
          await releasePreflight.promise;
          return await originalRead(...args);
        });
      const command = createDeferred<Awaited<ReturnType<typeof runCronCommandJob>>>();
      const commandStarted = createDeferred();
      let commandSignal: AbortSignal | undefined;
      const runCommandJob = vi.fn<NonNullable<CronServiceDeps["runCommandJob"]>>((params) => {
        commandSignal = params.abortSignal;
        commandStarted.resolve();
        return command.promise;
      });
      const { job, state } = commandFixture("stuck-command", ["unused"], runCommandJob);
      job.delivery = { mode: "none" };
      const activeJobMarker = markCronJobActive(job.id);
      let settled = false;
      const run = executeJobCoreWithTimeout(state, job, { activeJobMarker }).then((result) => {
        settled = true;
        return result;
      });
      try {
        await awaitGateBeforeSettlement(
          preflightStarted.promise,
          run,
          "Scheduled command settled before its migration preflight",
        );
        await vi.advanceTimersByTimeAsync(500);
        expect(settled).toBe(false);
        expect(runCommandJob).not.toHaveBeenCalled();
        if (completion === "revoked") {
          clearCronJobActive(job.id, activeJobMarker);
        }
        releasePreflight.resolve();
        if (completion === "revoked") {
          await expect(run).rejects.toThrow("Gateway restarting.");
          expect(runCommandJob).not.toHaveBeenCalled();
          await expectDrained();
          return;
        }
        await awaitGateBeforeSettlement(
          commandStarted.promise,
          run,
          "Scheduled command settled before entering the abort-ignoring runner",
        );
        await vi.advanceTimersByTimeAsync(499);
        expect(commandSignal?.aborted).toBe(false);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(commandSignal?.aborted).toBe(true);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await run).toMatchObject({
          status: "error",
          error: "cron: job execution timed out",
        });
        expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
        command.resolve({ status: "ok", summary: "late completion" });
        await expectDrained();
        expect(getSuspensionVisibleCronTaskRunCount()).toBe(0);
      } finally {
        releasePreflight.resolve();
        command.resolve({ status: "ok" });
        try {
          await run.catch(() => undefined);
        } finally {
          readReceipt.mockRestore();
          clearCronJobActive(job.id, activeJobMarker);
          vi.useRealTimers();
        }
      }
    },
  );
});

describe("cron agent setup watchdog", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    vi.useRealTimers();
  });

  function makeWatchdog(timeoutMultiplier = 3, executionKind: "agent" | "command" = "agent") {
    vi.useFakeTimers();
    const triggerTimeout = vi.fn();
    const watchdog = createCronAgentWatchdog({
      executionKind,
      deferUntilRunner: true,
      jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * timeoutMultiplier,
      triggerTimeout,
    });
    const jobId = "watchdog-job";
    const runner = (isFallback = false) =>
      watchdog.noteRunnerStarted({ jobId, phase: "runner_entered", isFallback });
    const phase = (nextPhase: CronAgentExecutionPhase) =>
      watchdog.notePhase({ jobId, phase: nextPhase });
    const advance = async (ms: number, execution?: Omit<CronAgentExecutionStarted, "jobId">) => {
      await vi.advanceTimersByTimeAsync(ms);
      expect(triggerTimeout.mock.calls).toEqual(
        execution ? [[preExecutionTimeoutErrorMessage({ jobId, ...execution })]] : [],
      );
    };
    watchdog.start();
    dispose = watchdog.dispose;
    const fallback = () => {
      phase("model_call_started");
      runner(true);
      phase("runtime_plugins");
    };
    return { triggerTimeout, watchdog, runner, phase, fallback, advance };
  }

  it.each(["setup", "execution"] as const)(
    "bounds command %s without expecting agent progress",
    async (phase) => {
      const { triggerTimeout, watchdog } = makeWatchdog(3, "command");
      if (phase === "execution") {
        watchdog.noteRunnerStarted();
      }
      await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS);
      if (phase === "setup") {
        expect(triggerTimeout).toHaveBeenCalledExactlyOnceWith(
          "cron: job execution timed out (command setup before runner start)",
        );
      } else {
        expect(triggerTimeout).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS * 2);
        expect(triggerTimeout).toHaveBeenCalledExactlyOnceWith("cron: job execution timed out");
      }
      expect(isCronTimeoutErrorText(triggerTimeout.mock.calls[0]?.[0])).toBe(true);
    },
  );

  it("keeps the pre-execution watchdog armed before initial progress", async () => {
    const { runner, advance } = makeWatchdog();
    runner();
    await advance(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
    await advance(1, { phase: "runner_entered" });
  });

  it("starts a fresh setup deadline after lane admission", async () => {
    const { triggerTimeout, watchdog, advance } = makeWatchdog(2);
    watchdog.noteLaneWait();
    await advance(CRON_AGENT_SETUP_WATCHDOG_MS + 1);
    expect(watchdog.observedLaneWait()).toBe(true);
    watchdog.noteLaneAdmitted();
    expect(triggerTimeout).not.toHaveBeenCalled();
    expect(watchdog.observedLaneWait()).toBe(false);
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);
    expect(triggerTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.observedLaneWait()).toBe(false);
  });

  it("keeps the fallback watchdog armed across later setup progress", async () => {
    const { runner, phase, fallback, advance } = makeWatchdog();
    runner();
    fallback();
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS / 2);
    phase("model_resolution");
    phase("auth");
    await advance(CRON_AGENT_SETUP_WATCHDOG_MS / 2, { phase: "auth" });
  });

  it("gives a fallback a fresh guard when the initial runner made no progress", async () => {
    const { runner, advance } = makeWatchdog();
    runner();
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
    runner(true);
    await advance(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
    await advance(1, { phase: "runner_entered", isFallback: true });
  });
});
