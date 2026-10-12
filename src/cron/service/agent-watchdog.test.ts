import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronAgentExecutionPhase } from "../types.js";
import { CRON_AGENT_SETUP_WATCHDOG_MS, createCronAgentWatchdog } from "./agent-watchdog.js";
import { preExecutionTimeoutErrorMessage } from "./execution-errors.js";

const initialSetupPhases = [
  "workspace",
  "runtime_plugins",
  "model_resolution",
  "auth",
  "context_engine",
] as const satisfies readonly CronAgentExecutionPhase[];

const fallbackSetupPhases = [
  "runtime_plugins",
  "model_resolution",
  "auth",
  "context_engine",
] as const satisfies readonly CronAgentExecutionPhase[];

function makeWatchdog(timeoutMultiplier = 3) {
  vi.useFakeTimers();
  const triggerTimeout = vi.fn();
  const watchdog = createCronAgentWatchdog({
    deferUntilRunner: true,
    jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * timeoutMultiplier,
    triggerTimeout,
  });
  return { triggerTimeout, watchdog };
}

describe("cron agent setup watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts setup timeout only after lane admission", async () => {
    const { triggerTimeout, watchdog } = makeWatchdog(2);

    watchdog.start();
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

  it("restarts the complete setup budget after repeated lane contention", async () => {
    const { triggerTimeout, watchdog } = makeWatchdog(2);

    watchdog.start();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      watchdog.noteLaneWait();
      await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS * 2);
      expect(triggerTimeout).not.toHaveBeenCalled();
      watchdog.noteLaneAdmitted();
      await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
      expect(triggerTimeout).not.toHaveBeenCalled();
    }

    await vi.advanceTimersByTimeAsync(1);

    expect(triggerTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.observedLaneWait()).toBe(false);
  });

  it("keeps the pre-execution watchdog armed for runner entry alone", async () => {
    const { triggerTimeout, watchdog } = makeWatchdog();
    const execution = { jobId: "runner-entry-only-job", phase: "runner_entered" } as const;

    watchdog.start();
    watchdog.noteRunnerStarted(execution);
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS);

    expect(triggerTimeout).toHaveBeenCalledExactlyOnceWith(
      preExecutionTimeoutErrorMessage(execution),
    );
    watchdog.dispose();
  });

  it.each(initialSetupPhases)(
    "lets initial %s progress use the configured job timeout",
    async (phase) => {
      const { triggerTimeout, watchdog } = makeWatchdog();
      const jobId = "initial-setup-progress-job";

      watchdog.start();
      watchdog.noteRunnerStarted({ jobId, phase: "runner_entered" });
      watchdog.notePhase({ jobId, phase });
      await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS);

      expect(triggerTimeout).not.toHaveBeenCalled();
      watchdog.dispose();
    },
  );

  it.each(fallbackSetupPhases)(
    "rearms the pre-execution watchdog when execution falls back to %s",
    async (fallbackPhase) => {
      const { triggerTimeout, watchdog } = makeWatchdog();
      const jobId = "fallback-watchdog-job";

      watchdog.start();
      watchdog.noteRunnerStarted({ jobId, phase: "runner_entered" });
      watchdog.notePhase({ jobId, phase: "model_call_started" });
      watchdog.noteRunnerStarted({ jobId, phase: "runner_entered", isFallback: true });
      watchdog.notePhase({ jobId, phase: fallbackPhase });

      await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
      expect(triggerTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(triggerTimeout).toHaveBeenCalledExactlyOnceWith(
        preExecutionTimeoutErrorMessage({ jobId, phase: fallbackPhase }),
      );
      watchdog.dispose();
    },
  );

  it("keeps the fallback watchdog armed across later setup progress", async () => {
    const { triggerTimeout, watchdog } = makeWatchdog();
    const jobId = "fallback-progress-job";

    watchdog.start();
    watchdog.noteRunnerStarted({ jobId, phase: "runner_entered" });
    watchdog.notePhase({ jobId, phase: "model_call_started" });
    watchdog.noteRunnerStarted({ jobId, phase: "runner_entered", isFallback: true });
    watchdog.notePhase({ jobId, phase: "runtime_plugins" });
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS / 2);
    watchdog.notePhase({ jobId, phase: "model_resolution" });
    watchdog.notePhase({ jobId, phase: "auth" });
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS / 2);

    expect(triggerTimeout).toHaveBeenCalledExactlyOnceWith(
      preExecutionTimeoutErrorMessage({ jobId, phase: "auth" }),
    );
    watchdog.dispose();
  });

  it("gives a fallback a fresh guard when the initial runner made no progress", async () => {
    const { triggerTimeout, watchdog } = makeWatchdog();
    const jobId = "fallback-after-stalled-runner-job";

    watchdog.start();
    watchdog.noteRunnerStarted({ jobId, phase: "runner_entered" });
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
    watchdog.noteRunnerStarted({ jobId, phase: "runner_entered", isFallback: true });
    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS - 1);

    expect(triggerTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(triggerTimeout).toHaveBeenCalledExactlyOnceWith(
      preExecutionTimeoutErrorMessage({ jobId, phase: "runner_entered", isFallback: true }),
    );
    watchdog.dispose();
  });
});
