import { describe, expect, it } from "vitest";
import {
  isOffsetlessIsoDateTime,
  parseOffsetlessIsoDateTimeInTimeZone,
} from "./parse-offsetless-zoned-datetime.js";

describe("parseOffsetlessIsoDateTimeInTimeZone", () => {
  it("detects offset-less ISO datetimes", () => {
    expect(isOffsetlessIsoDateTime("2026-03-23T23:00:00")).toBe(true);
    expect(isOffsetlessIsoDateTime("2026-03-23T23:00:00+02:00")).toBe(false);
    expect(isOffsetlessIsoDateTime("+20m")).toBe(false);
  });

  it("converts offset-less datetimes in the requested timezone", () => {
    expect(parseOffsetlessIsoDateTimeInTimeZone("2026-03-23T23:00:00", "Europe/Oslo")).toBe(
      "2026-03-23T22:00:00.000Z",
    );
  });

  it("keeps DST boundary conversions on the intended wall-clock time", () => {
    expect(parseOffsetlessIsoDateTimeInTimeZone("2026-03-29T01:30:00", "Europe/Oslo")).toBe(
      "2026-03-29T00:30:00.000Z",
    );
  });

  it("returns null for nonexistent DST gap wall-clock times", () => {
    expect(parseOffsetlessIsoDateTimeInTimeZone("2026-03-29T02:30:00", "Europe/Oslo")).toBe(null);
  });

  it("returns null for invalid input", () => {
    expect(parseOffsetlessIsoDateTimeInTimeZone("2026-03-23T23:00:00+02:00", "Europe/Oslo")).toBe(
      null,
    );
    expect(parseOffsetlessIsoDateTimeInTimeZone("2026-03-23T23:00:00", "Invalid/Timezone")).toBe(
      null,
    );
  });
});
