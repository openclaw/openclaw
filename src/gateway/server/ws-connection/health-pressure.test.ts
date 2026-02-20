import { describe, expect, it } from "vitest";
import { shouldThrottleHealthRequest } from "./health-pressure.js";

describe("shouldThrottleHealthRequest", () => {
  it("throttles non-probe health when cached data exists and interval is too short", () => {
    expect(
      shouldThrottleHealthRequest({
        method: "health",
        probe: false,
        cachedAvailable: true,
        nowMs: 100,
        lastHealthRequestAtMs: 0,
        minIntervalMs: 250,
      }),
    ).toBe(true);
  });

  it.each([
    { method: "status", probe: false, cachedAvailable: true },
    { method: "health", probe: true, cachedAvailable: true },
    { method: "health", probe: false, cachedAvailable: false },
  ])(
    "does not throttle when preconditions are not met: %#",
    ({ method, probe, cachedAvailable }) => {
      expect(
        shouldThrottleHealthRequest({
          method,
          probe,
          cachedAvailable,
          nowMs: 500,
          lastHealthRequestAtMs: 0,
          minIntervalMs: 250,
        }),
      ).toBe(false);
    },
  );
});
