// Regression: restart control-flow deadlines must follow the monotonic clock.
// A wall-clock step (NTP correction, VM suspend/resume) must not extend the
// SIGUSR2 authorization grace, fire deferral timeouts early, or collapse the
// restart cooldown. setSystemTime moves only the wall clock; the faked
// performance clock stays monotonic, which models the real failure mode.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  consumeGatewayRestartAuthorization,
  deferGatewayRestartUntilIdle,
  markGatewayRestartHandled,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
} from "./restart.js";

const restartSignalHandler = () => {};

describe("restart control-flow deadlines use the monotonic clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    process.on("SIGUSR2", restartSignalHandler);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    process.removeListener("SIGUSR2", restartSignalHandler);
  });

  it("expires SIGUSR2 authorization grace on monotonic time despite wall-clock rollback", () => {
    expect(requestGatewayRestartWithSignalAdmission("probe")).toEqual({ status: "emitted" });
    vi.advanceTimersByTime(4_000);
    vi.setSystemTime(Date.now() - 10_000);
    vi.advanceTimersByTime(4_000); // monotonic 8s > 5s grace
    expect(consumeGatewayRestartAuthorization()).toBe(false);
  });

  it("keeps SIGUSR2 authorization grace when monotonic time is inside the window", () => {
    expect(requestGatewayRestartWithSignalAdmission("probe")).toEqual({ status: "emitted" });
    vi.advanceTimersByTime(4_000);
    vi.setSystemTime(Date.now() - 10_000); // wall-clock rollback only
    expect(consumeGatewayRestartAuthorization()).toBe(true);
  });

  it("does not fire the deferral timeout early on a wall-clock forward jump", () => {
    const onTimeout = vi.fn();
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      hooks: { onTimeout },
      maxWaitMs: 120_000,
    });
    vi.advanceTimersByTime(10_000);
    vi.setSystemTime(Date.now() + 300_000); // VM suspend/resume
    vi.advanceTimersByTime(500);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(110_000); // monotonic reaches the 120s cap
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("fires the deferral timeout at the cap despite wall-clock rollback", () => {
    const onTimeout = vi.fn();
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      hooks: { onTimeout },
      maxWaitMs: 120_000,
    });
    vi.advanceTimersByTime(119_000);
    vi.setSystemTime(Date.now() - 60_000);
    vi.advanceTimersByTime(1_000); // monotonic 120s reaches the cap
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("keeps the restart cooldown across a wall-clock forward jump", () => {
    expect(requestGatewayRestartWithSignalAdmission("first")).toEqual({ status: "emitted" });
    expect(consumeGatewayRestartAuthorization()).toBe(true);
    markGatewayRestartHandled();

    vi.setSystemTime(Date.now() + 60_000);
    const second = scheduleGatewayRestart({ delayMs: 0, reason: "second" });
    expect(second.cooldownMsApplied).toBe(30_000);
    expect(second.delayMs).toBe(30_000);
  });
});
