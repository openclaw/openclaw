import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronAgentExecutionPhase, CronAgentExecutionStarted } from "../types.js";
import { CRON_AGENT_SETUP_WATCHDOG_MS, createCronAgentWatchdog } from "./agent-watchdog.js";
import { preExecutionTimeoutErrorMessage } from "./execution-errors.js";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.useRealTimers();
});

function makeWatchdog(timeoutMultiplier = 3) {
  vi.useFakeTimers();
  const triggerTimeout = vi.fn();
  const watchdog = createCronAgentWatchdog({
    deferUntilRunner: true,
    jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * timeoutMultiplier,
    triggerTimeout,
  });
  const jobId = "watchdog-job";
  const runner = (isFallback = false) =>
    watchdog.noteRunnerStarted({ jobId, phase: "runner_entered", isFallback });
  const phase = (nextPhase: CronAgentExecutionPhase) =>
    watchdog.notePhase({ jobId, phase: nextPhase });
  const expectTimeout = (execution: Omit<CronAgentExecutionStarted, "jobId">) =>
    expect(triggerTimeout).toHaveBeenCalledExactlyOnceWith(
      preExecutionTimeoutErrorMessage({ jobId, ...execution }),
    );
  watchdog.start();
  dispose = watchdog.dispose;
  const fallback = () => {
    phase("model_call_started");
    runner(true);
    phase("runtime_plugins");
  };
  return { triggerTimeout, watchdog, runner, phase, fallback, expectTimeout };
}

describe("cron agent setup watchdog", () => {
  it("starts setup timeout only after lane admission", async () => {
    const { triggerTimeout, watchdog } = makeWatchdog(2);

    watchdog.noteLaneWait();

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);

    expect(triggerTimeout).not.toHaveBeenCalled();
    expect(watchdog.observedLaneWait()).toBe(true);

    watchdog.noteLaneAdmitted();

    expect(triggerTimeout).not.toHaveBeenCalled();
    expect(watchdog.observedLaneWait()).toBe(false);

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);

    expect(triggerTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.observedLaneWait()).toBe(false);
  });

  it("lets initial workspace progress use the configured job timeout", async () => {
    const { triggerTimeout, runner, phase } = makeWatchdog();
    runner();
    phase("workspace");
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS);

    expect(triggerTimeout).not.toHaveBeenCalled();
  });

  it.each(["runner_entered", "runtime_plugins"] as const)(
    "keeps the pre-execution watchdog armed at %s",
    async (phase) => {
      const { triggerTimeout, runner, fallback, expectTimeout } = makeWatchdog();
      runner();
      if (phase === "runtime_plugins") {
        fallback();
      }

      await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
      expect(triggerTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expectTimeout({ phase });
    },
  );

  it("keeps the fallback watchdog armed across later setup progress", async () => {
    const { runner, phase, fallback, expectTimeout } = makeWatchdog();
    runner();
    fallback();
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS / 2);
    phase("model_resolution");
    phase("auth");
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS / 2);

    expectTimeout({ phase: "auth" });
  });

  it("gives a fallback a fresh guard when the initial runner made no progress", async () => {
    const { triggerTimeout, runner, expectTimeout } = makeWatchdog();
    runner();
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
    runner(true);
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);

    expect(triggerTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expectTimeout({ phase: "runner_entered", isFallback: true });
  });
});
