import { describe, expect, it } from "vitest";
import { assertCronActiveHours, isCronWithinActiveHours } from "./active-hours.js";

describe("automation execution windows", () => {
  it.each([
    ["2026-09-01T08:59:59Z", false],
    ["2026-09-01T09:00:00Z", true],
    ["2026-09-01T16:59:59Z", true],
    ["2026-09-01T17:00:00Z", false],
  ])("uses an inclusive start and exclusive end at %s", (time, expected) => {
    expect(
      isCronWithinActiveHours({ start: "09:00", end: "17:00", timezone: "UTC" }, Date.parse(time)),
    ).toBe(expected);
  });

  it("keeps both repeated DST hours and an overnight window", () => {
    const window = { start: "22:00", end: "02:00", timezone: "America/New_York" };
    expect(isCronWithinActiveHours(window, Date.parse("2026-11-01T05:30:00Z"))).toBe(true);
    expect(isCronWithinActiveHours(window, Date.parse("2026-11-01T06:30:00Z"))).toBe(true);
    expect(isCronWithinActiveHours(window, Date.parse("2026-11-01T07:00:00Z"))).toBe(false);
  });

  it("distinguishes an all-day end marker from a zero-length window", () => {
    const now = Date.parse("2026-09-01T23:59:59Z");
    expect(isCronWithinActiveHours({ start: "00:00", end: "24:00", timezone: "UTC" }, now)).toBe(
      true,
    );
    expect(isCronWithinActiveHours({ start: "00:00", end: "00:00", timezone: "UTC" }, now)).toBe(
      false,
    );
    expect(isCronWithinActiveHours(undefined, now)).toBe(true);
  });

  it("uses the configured user timezone when no job timezone is provided", () => {
    const now = Date.parse("2026-09-01T16:00:00Z");
    expect(
      isCronWithinActiveHours({ start: "09:00", end: "10:00" }, now, "America/Los_Angeles"),
    ).toBe(true);
    expect(isCronWithinActiveHours({ start: "09:00", end: "10:00" }, now, "UTC")).toBe(false);
  });

  it.each([
    { start: "24:00", end: "24:00" },
    { start: "09:00", end: "24:01" },
    { start: "09:00", end: "17:00", timezone: "not/a-timezone" },
  ])("refuses invalid authored windows", (window) => {
    expect(() => assertCronActiveHours(window)).toThrow();
  });
});
