// Ownership backoff for queued generated-media delivery.
import { describe, expect, it } from "vitest";
import { agentDeliveryOwnershipRetryDelayMs } from "./server-restart-sentinel-agent-delivery.js";

describe("agentDeliveryOwnershipRetryDelayMs", () => {
  const now = 1_000_000_000;

  // The row rewrite happens once per defer, so this bounds a stuck entry's write rate.
  it.each([
    ["a fresh", 0, 1_000],
    ["a just-under-a-minute-old", 59_999, 1_000],
    ["a one-minute-old", 60_000, 2_000],
    ["a two-minute-old", 120_000, 4_000],
    ["a five-minute-old", 300_000, 32_000],
    ["a ten-minute-old", 600_000, 60_000],
    ["an hours-old", 6 * 60 * 60_000, 60_000],
    ["a clock-skewed", -5_000, 1_000],
  ])("backs off %s ownership wait", (_label, ageMs, expected) => {
    expect(agentDeliveryOwnershipRetryDelayMs(now - ageMs, now)).toBe(expected);
  });
});
