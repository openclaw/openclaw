import { describe, expect, it } from "vitest";
import { cronSchedulingInputsEqual, tryCronScheduleIdentity } from "./schedule-identity.js";

describe("tryCronScheduleIdentity", () => {
  it("normalizes numeric schedule strings like execution does", () => {
    const stringNumericSchedule = {
      schedule: { kind: "every", everyMs: "60000", anchorMs: "123" },
    } as unknown as Parameters<typeof cronSchedulingInputsEqual>[1];
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
        stringNumericSchedule,
      ),
    ).toBe(true);
  });
});
