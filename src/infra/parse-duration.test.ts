import { describe, expect, it } from "vitest";
import { parseDuration, formatDurationMs } from "./parse-duration.js";

describe("parseDuration", () => {
  it("parses minutes", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1m")).toBe(60_000);
    expect(parseDuration("90m")).toBe(5_400_000);
  });

  it("parses hours", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("4h")).toBe(14_400_000);
    expect(parseDuration("24h")).toBe(86_400_000);
  });

  it("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });

  it("parses days", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  it("is case-insensitive", () => {
    expect(parseDuration("30M")).toBe(1_800_000);
    expect(parseDuration("1H")).toBe(3_600_000);
  });

  it("returns null for invalid input", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("30")).toBeNull();
    expect(parseDuration("-1m")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("1x")).toBeNull();
  });
});

describe("formatDurationMs", () => {
  it("formats minutes", () => {
    expect(formatDurationMs(1_800_000)).toBe("30m");
    expect(formatDurationMs(60_000)).toBe("1m");
  });

  it("formats hours", () => {
    expect(formatDurationMs(3_600_000)).toBe("1h");
    expect(formatDurationMs(7_200_000)).toBe("2h");
  });

  it("formats hours and minutes", () => {
    expect(formatDurationMs(5_400_000)).toBe("1h 30m");
  });

  it("formats seconds", () => {
    expect(formatDurationMs(30_000)).toBe("30s");
  });
});
