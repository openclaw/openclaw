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

describe("cron agent setup watchdog", () => {
  it("starts setup timeout only after lane admission", async () => {
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

  it("lets initial workspace progress use the configured job timeout", async () => {
    const { runner, phase, advance } = makeWatchdog();
    runner();
    phase("workspace");
    await advance(CRON_AGENT_SETUP_WATCHDOG_MS);
  });

  it.each(["runner_entered", "runtime_plugins"] as const)(
    "keeps the pre-execution watchdog armed at %s",
    async (phase) => {
      const { runner, fallback, advance } = makeWatchdog();
      runner();
      if (phase === "runtime_plugins") {
        fallback();
      }

      await advance(CRON_AGENT_SETUP_WATCHDOG_MS - 1);
      await advance(1, { phase });
    },
  );

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
