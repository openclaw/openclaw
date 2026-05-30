import { describe, expect, it } from "vitest";
import { resolveCronAgentSetupWatchdogMs } from "./timer.js";

describe("resolveCronAgentSetupWatchdogMs", () => {
  it("defaults to 60s when no override is provided", () => {
    expect(resolveCronAgentSetupWatchdogMs(undefined)).toBe(60_000);
    expect(resolveCronAgentSetupWatchdogMs({})).toBe(60_000);
  });

  it("honours a valid override", () => {
    expect(resolveCronAgentSetupWatchdogMs({ agentSetupWatchdogMs: 120_000 })).toBe(120_000);
    expect(resolveCronAgentSetupWatchdogMs({ agentSetupWatchdogMs: 90_000 })).toBe(90_000);
  });

  it("floors fractional overrides", () => {
    expect(resolveCronAgentSetupWatchdogMs({ agentSetupWatchdogMs: 90_500.9 })).toBe(90_500);
  });

  it("clamps overrides below the safety minimum (1s) so the watchdog cannot be disabled", () => {
    expect(resolveCronAgentSetupWatchdogMs({ agentSetupWatchdogMs: 0 })).toBe(1_000);
    expect(resolveCronAgentSetupWatchdogMs({ agentSetupWatchdogMs: -5_000 })).toBe(1_000);
    expect(resolveCronAgentSetupWatchdogMs({ agentSetupWatchdogMs: 500 })).toBe(1_000);
  });

  it("falls back to the default for non-finite values", () => {
    expect(resolveCronAgentSetupWatchdogMs({ agentSetupWatchdogMs: Number.NaN })).toBe(60_000);
    expect(
      resolveCronAgentSetupWatchdogMs({
        agentSetupWatchdogMs: Number.POSITIVE_INFINITY,
      }),
    ).toBe(60_000);
  });
});
