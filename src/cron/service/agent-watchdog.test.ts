import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_AGENT_SETUP_WATCHDOG_MS, createCronAgentWatchdog } from "./agent-watchdog.js";

describe("cron agent setup watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("fires setup timeout at the configured setupTimeoutMs instead of the default", async () => {
    vi.useFakeTimers();
    const triggerTimeout = vi.fn();
    const customSetupMs = 120_000;
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: true,
      jobTimeoutMs: customSetupMs * 2,
      setupTimeoutMs: customSetupMs,
      triggerTimeout,
    });

    watchdog.start();

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);
    expect(triggerTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(customSetupMs - CRON_AGENT_SETUP_WATCHDOG_MS);
    expect(triggerTimeout).toHaveBeenCalledTimes(1);
  });

  it("defaults setup timeout to CRON_AGENT_SETUP_WATCHDOG_MS when setupTimeoutMs is not provided", async () => {
    vi.useFakeTimers();
    const triggerTimeout = vi.fn();
    const watchdog = createCronAgentWatchdog({
      deferUntilRunner: true,
      jobTimeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS * 2,
      triggerTimeout,
    });

    watchdog.start();

    await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);
    expect(triggerTimeout).toHaveBeenCalledTimes(1);
  });
});
