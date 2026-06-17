import { describe, expect, it } from "vitest";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";

describe("summarizeToolDescriptionText", () => {
  it("keeps uppercase-like first lines with digits as summary text", () => {
    expect(
      summarizeToolDescriptionText({
        rawDescription: "1234567890ABC:\nRun the fallback summary.",
      }),
    ).toBe("1234567890ABC:");
  });

  it.each(["ACTIONS:", "JOB SCHEMA:"])(
    "skips known doc block header %s",
    (header) => {
      expect(
        summarizeToolDescriptionText({
          rawDescription: `${header}\n- run\n\nUse the stable action summary.`,
        }),
      ).toBe("Use the stable action summary.");
    },
  );

  it("skips long uppercase headings that contain letters", () => {
    expect(
      summarizeToolDescriptionText({
        rawDescription: "CUSTOM ACTIONS:\n- run\n\nUse the custom action summary.",
      }),
    ).toBe("Use the custom action summary.");
  });

  it("skips long uppercase headings with later digits", () => {
    expect(
      summarizeToolDescriptionText({
        rawDescription: "API V2 OPTIONS:\n- run\n\nUse the versioned action summary.",
      }),
    ).toBe("Use the versioned action summary.");
  });
});
