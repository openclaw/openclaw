import { describe, expect, it } from "vitest";
import { resolveNonInteractiveRescueWatchdogPlan } from "./local.js";

describe("resolveNonInteractiveRescueWatchdogPlan", () => {
  it("does not force daemon install for rescue profiles", () => {
    const plan = resolveNonInteractiveRescueWatchdogPlan({
      opts: { rescueWatchdog: true, installDaemon: false },
      monitoredProfile: "work-rescue",
      platform: "darwin",
      systemdAvailable: true,
    });

    expect(plan.installDaemon).toBe(false);
    expect(plan.rescueWatchdogEnabled).toBe(false);
    expect(plan.messages).toEqual([
      'Rescue watchdog is not supported while onboarding the "work-rescue" profile; skipping rescue watchdog setup.',
    ]);
  });

  it("skips rescue watchdog on Linux when systemd user services are unavailable", () => {
    const plan = resolveNonInteractiveRescueWatchdogPlan({
      opts: { rescueWatchdog: true, installDaemon: false },
      monitoredProfile: "default",
      platform: "linux",
      systemdAvailable: false,
    });

    expect(plan.installDaemon).toBe(false);
    expect(plan.rescueWatchdogEnabled).toBe(false);
    expect(plan.messages).toEqual([
      "Rescue watchdog requires systemd user services on Linux, but they are unavailable here; skipping rescue watchdog setup.",
    ]);
  });

  it("enables daemon install when rescue watchdog is available", () => {
    const plan = resolveNonInteractiveRescueWatchdogPlan({
      opts: { rescueWatchdog: true, installDaemon: false },
      monitoredProfile: "default",
      platform: "darwin",
      systemdAvailable: true,
    });

    expect(plan.installDaemon).toBe(true);
    expect(plan.rescueWatchdogEnabled).toBe(true);
    expect(plan.messages).toEqual([
      "Rescue watchdog requested; enabling managed Gateway service install.",
    ]);
  });
});
