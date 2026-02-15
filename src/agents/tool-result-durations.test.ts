import { describe, expect, it } from "vitest";
import { isToolResultDurationTrackingEnabled } from "./tool-result-durations.js";

describe("isToolResultDurationTrackingEnabled", () => {
  it("defaults to enabled when unset", () => {
    expect(isToolResultDurationTrackingEnabled(undefined)).toBe(true);
    expect(isToolResultDurationTrackingEnabled({})).toBe(true);
  });

  it("respects explicit disable flag", () => {
    expect(
      isToolResultDurationTrackingEnabled({
        agents: {
          defaults: {
            toolResultDurations: {
              enabled: false,
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("keeps enabled when explicitly true", () => {
    expect(
      isToolResultDurationTrackingEnabled({
        agents: {
          defaults: {
            toolResultDurations: {
              enabled: true,
            },
          },
        },
      }),
    ).toBe(true);
  });
});
