// Cron parse tests cover CLI and config parsing for scheduled jobs.
import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  it("parses positive epoch milliseconds", () => {
    expect(parseAbsoluteTimeMs("1700000000000")).toBe(1_700_000_000_000);
  });

  it("rejects digit-only timestamps outside the Date range", () => {
    expect(parseAbsoluteTimeMs(String(Number.MAX_SAFE_INTEGER))).toBeNull();
  });

  it("parses ISO timestamps with UTC defaults and explicit offsets", () => {
    expect(parseAbsoluteTimeMs("2026-02-28")).toBe(Date.parse("2026-02-28T00:00:00Z"));
    expect(parseAbsoluteTimeMs("2026-02-28T12:34:56.789Z")).toBe(
      Date.parse("2026-02-28T12:34:56.789Z"),
    );
    expect(parseAbsoluteTimeMs("2026-02-28T24:00:00Z")).toBe(Date.parse("2026-02-28T24:00:00Z"));
    expect(parseAbsoluteTimeMs("2026-02-28T12:34:56+08:00")).toBe(
      Date.parse("2026-02-28T12:34:56+08:00"),
    );
  });

  it.each([
    "2023-02-29",
    "2026-02-31",
    "2026-02-31T00:00:00Z",
    "2026-04-31T12:34:56Z",
    "2026-01-01T25:00:00Z",
    "December 17, 2026 03:24:00",
    "2026/12/17",
  ])("rejects invalid absolute timestamp %s", (input) => {
    expect(parseAbsoluteTimeMs(input)).toBeNull();
  });
});
