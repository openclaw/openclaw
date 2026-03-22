import { describe, expect, it } from "vitest";
import { collectDoctorPreviewWarnings } from "./preview-warnings.js";

describe("doctor preview warnings", () => {
  it("collects provider and shared preview warnings", () => {
    const warnings = collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["@alice"],
          },
          signal: {
            dmPolicy: "open",
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("Telegram allowFrom contains 1 non-numeric entries"),
      expect.stringContaining('channels.signal.allowFrom: set to ["*"]'),
    ]);
  });
});
