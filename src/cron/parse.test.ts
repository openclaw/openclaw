import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  it("returns null for empty string", () => {
    expect(parseAbsoluteTimeMs("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(parseAbsoluteTimeMs("   ")).toBeNull();
  });

  it("returns null for non-date input", () => {
    expect(parseAbsoluteTimeMs("not-a-date")).toBeNull();
  });

  it("passes through positive integer epoch ms", () => {
    expect(parseAbsoluteTimeMs("1713024000000")).toBe(1713024000000);
  });

  it("floors non-integer-looking numeric input to integer epoch ms", () => {
    // All-digits path only — decimals fall through to Date.parse
    expect(parseAbsoluteTimeMs("1713024000001")).toBe(1713024000001);
  });

  it("trims whitespace around numeric input", () => {
    expect(parseAbsoluteTimeMs("  1713024000000  ")).toBe(1713024000000);
  });

  it("normalizes a date-only string to UTC midnight", () => {
    expect(parseAbsoluteTimeMs("2026-04-16")).toBe(Date.parse("2026-04-16T00:00:00Z"));
  });

  it("appends Z to a date-time missing a timezone", () => {
    expect(parseAbsoluteTimeMs("2026-04-16T12:00:00")).toBe(Date.parse("2026-04-16T12:00:00Z"));
  });

  it("passes through an ISO timestamp that already has Z", () => {
    expect(parseAbsoluteTimeMs("2026-04-16T12:00:00Z")).toBe(Date.parse("2026-04-16T12:00:00Z"));
  });

  it("passes through an ISO timestamp with a numeric offset", () => {
    expect(parseAbsoluteTimeMs("2026-04-16T12:00:00+03:00")).toBe(
      Date.parse("2026-04-16T09:00:00Z"),
    );
  });

  it("accepts an offset without a colon", () => {
    expect(parseAbsoluteTimeMs("2026-04-16T12:00:00+0300")).toBe(
      Date.parse("2026-04-16T09:00:00Z"),
    );
  });

  it("returns null for a malformed date-time tail", () => {
    expect(parseAbsoluteTimeMs("2026-04-16T99:99:99")).toBeNull();
  });
});
