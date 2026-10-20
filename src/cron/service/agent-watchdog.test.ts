import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronAgentExecutionPhase, CronAgentExecutionStarted } from "../types.js";
import { CRON_AGENT_SETUP_WATCHDOG_MS, createCronAgentWatchdog } from "./agent-watchdog.js";
import { preExecutionTimeoutErrorMessage } from "./execution-errors.js";

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
    watchdog.noteRunnerStarted({
      jobId,
      phase: "runner_entered",
      ...(isFallback ? { isFallback } : {}),
    });
  const phase = (nextPhase: CronAgentExecutionPhase) =>
    watchdog.notePhase({ jobId, phase: nextPhase });
  const expectTimeout = (execution: Omit<CronAgentExecutionStarted, "jobId">) =>
    expect(triggerTimeout).toHaveBeenCalledExactlyOnceWith(
      preExecutionTimeoutErrorMessage({ jobId, ...execution }),
    );
  watchdog.start();
  return { triggerTimeout, watchdog, runner, phase, expectTimeout };
}

describe("cron agent setup watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("keeps the pre-execution watchdog armed for runner entry alone", async () => {
    const { watchdog, runner, expectTimeout } = makeWatchdog();
    runner();
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS);

    expectTimeout({ phase: "runner_entered" });
    watchdog.dispose();
  });

  it("lets initial workspace progress use the configured job timeout", async () => {
    const { triggerTimeout, watchdog, runner, phase } = makeWatchdog();
    runner();
    phase("workspace");
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS);

    expect(triggerTimeout).not.toHaveBeenCalled();
    watchdog.dispose();
  });

  it("rearms the pre-execution watchdog when execution falls back to runtime_plugins", async () => {
    const { triggerTimeout, watchdog, runner, phase, expectTimeout } = makeWatchdog();
    runner();
    phase("model_call_started");
    runner(true);
    phase("runtime_plugins");

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
    expect(triggerTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expectTimeout({ phase: "runtime_plugins" });
    watchdog.dispose();
  });

  it("keeps the fallback watchdog armed across later setup progress", async () => {
    const { watchdog, runner, phase, expectTimeout } = makeWatchdog();
    runner();
    phase("model_call_started");
    runner(true);
    phase("runtime_plugins");
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS / 2);
    phase("model_resolution");
    phase("auth");
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS / 2);

    expectTimeout({ phase: "auth" });
    watchdog.dispose();
  });

  it("gives a fallback a fresh guard when the initial runner made no progress", async () => {
    const { triggerTimeout, watchdog, runner, expectTimeout } = makeWatchdog();
    runner();
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
    runner(true);
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);

    expect(triggerTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expectTimeout({ phase: "runner_entered", isFallback: true });
    watchdog.dispose();
  });
});
