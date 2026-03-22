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

  it("sanitizes empty-allowlist warning paths before returning preview output", () => {
    const warnings = collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          signal: {
            accounts: {
              "ops\u001B[31m-team\u001B[0m\r\nnext": {
                dmPolicy: "allowlist",
              },
            },
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("channels.signal.accounts.ops-teamnext.dmPolicy"),
    ]);
    expect(warnings[0]).not.toContain("\u001B");
    expect(warnings[0]).not.toContain("\r");
  });
});
