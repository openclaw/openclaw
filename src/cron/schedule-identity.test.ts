import { describe, expect, it } from "vitest";
import { cronSchedulingInputsEqual, tryCronScheduleIdentity } from "./schedule-identity.js";

describe("tryCronScheduleIdentity", () => {
  it("normalizes numeric schedule strings like execution does", () => {
    const numeric = tryCronScheduleIdentity({
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 },
    });
    const stringNumeric = tryCronScheduleIdentity({
      enabled: true,
      schedule: { kind: "every", everyMs: "60000", anchorMs: "123" },
    });

    expect(stringNumeric).toBe(numeric);
    expect(
      cronSchedulingInputsEqual(
        { schedule: { kind: "every", everyMs: 60_000, anchorMs: 123 } },
        { schedule: { kind: "every", everyMs: "60000", anchorMs: "123" } },
      ),
    ).toBe(true);
  });
});
