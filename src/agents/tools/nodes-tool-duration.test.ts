import { describe, expect, it } from "vitest";
import { MAX_RECORDING_DURATION_MS } from "./nodes-tool.js";

/** Mirror the clamping logic used by screen_record / camera_clip handlers. */
function clampDuration(raw: number): number {
  return Math.max(1_000, Math.min(raw, MAX_RECORDING_DURATION_MS));
}

describe("screen_record / camera_clip duration clamping", () => {
  it("exports MAX_RECORDING_DURATION_MS as 5 minutes", () => {
    expect(MAX_RECORDING_DURATION_MS).toBe(300_000);
  });

  it("clamps excessively large durations to the maximum", () => {
    expect(clampDuration(86_400_000)).toBe(MAX_RECORDING_DURATION_MS); // 24 hours
    expect(clampDuration(3_600_000)).toBe(MAX_RECORDING_DURATION_MS); // 1 hour
    expect(clampDuration(600_000)).toBe(MAX_RECORDING_DURATION_MS); // 10 minutes
  });

  it("clamps sub-second values to the 1s floor", () => {
    expect(clampDuration(0)).toBe(1_000);
    expect(clampDuration(-1)).toBe(1_000);
    expect(clampDuration(500)).toBe(1_000);
    expect(clampDuration(999)).toBe(1_000);
  });

  it("passes through valid durations unchanged", () => {
    expect(clampDuration(1_000)).toBe(1_000); // exactly 1s
    expect(clampDuration(10_000)).toBe(10_000); // default screen_record
    expect(clampDuration(3_000)).toBe(3_000); // default camera_clip
    expect(clampDuration(60_000)).toBe(60_000); // 1 minute
    expect(clampDuration(300_000)).toBe(300_000); // exactly max
  });
});
