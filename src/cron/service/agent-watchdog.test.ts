import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_AGENT_SETUP_WATCHDOG_MS, createCronAgentWatchdog } from "./agent-watchdog.js";

describe("cron agent setup watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows setup to continue past 60 seconds when the job timeout budget allows it", async () => {
    vi.useFakeTimers();
    const triggerTimeout = vi.fn();
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: true,
      jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * 5,
      triggerTimeout,
    });

    watchdog.start();

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 10_000);
    watchdog.noteRunnerStarted();

    expect(triggerTimeout).not.toHaveBeenCalled();
  });

  it("does not keep lane-wait suppression after lane admission", async () => {
    vi.useFakeTimers();
    const triggerTimeout = vi.fn();
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: true,
      jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * 2,
      triggerTimeout,
    });

    watchdog.start();
    watchdog.noteLaneWait();
    watchdog.noteLaneAdmitted();

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);

    expect(triggerTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.observedLaneWait()).toBe(false);
  });

  it("keeps lane-wait evidence after setup timeout fires", async () => {
    vi.useFakeTimers();
    const triggerTimeout = vi.fn();
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: true,
      jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * 2,
      triggerTimeout,
    });

    watchdog.start();
    watchdog.noteLaneWait();

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);

    watchdog.noteLaneAdmitted();

    expect(triggerTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.observedLaneWait()).toBe(true);
  });
});
