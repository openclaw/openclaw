import { describe, expect, it } from "vitest";
import { parseDurationMs, parseTimeFilter } from "./parse-time-filter.js";

describe("parseDurationMs", () => {
  it("parses each supported unit", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("7d")).toBe(7 * 86_400_000);
    expect(parseDurationMs("1w")).toBe(604_800_000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDurationMs("  2h  ")).toBe(7_200_000);
  });

  it("rejects unknown or malformed input", () => {
    expect(parseDurationMs("2x")).toBeNull();
    expect(parseDurationMs("abc")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("2.5h")).toBeNull();
    expect(parseDurationMs("-2h")).toBeNull();
  });
});

describe("parseTimeFilter", () => {
  const now = Date.UTC(2026, 3, 21, 12, 0, 0);

  it("returns null when neither option is given", () => {
    expect(parseTimeFilter({}, now)).toBeNull();
  });

  it("treats --last as now minus duration", () => {
    const filter = parseTimeFilter({ last: "2h" }, now);
    expect(filter).toEqual({ sinceMs: now - 7_200_000, label: "last 2h" });
  });

  it("treats --since duration-form as now minus duration", () => {
    const filter = parseTimeFilter({ since: "7d" }, now);
    expect(filter).toEqual({ sinceMs: now - 7 * 86_400_000, label: "last 7d" });
  });

  it("parses --since ISO date", () => {
    const filter = parseTimeFilter({ since: "2026-04-20" }, now);
    expect(filter?.sinceMs).toBe(Date.parse("2026-04-20"));
    expect(filter?.label).toContain("since ");
  });

  it("parses --since ISO timestamp", () => {
    const filter = parseTimeFilter({ since: "2026-04-20T10:30:00Z" }, now);
    expect(filter?.sinceMs).toBe(Date.parse("2026-04-20T10:30:00Z"));
  });

  it("throws when both --since and --last are given", () => {
    expect(() => parseTimeFilter({ since: "2h", last: "1h" }, now)).toThrow(
      /cannot both be specified/,
    );
  });

  it("throws on invalid --last", () => {
    expect(() => parseTimeFilter({ last: "nonsense" }, now)).toThrow(/Invalid --last duration/);
  });

  it("throws on invalid --since", () => {
    expect(() => parseTimeFilter({ since: "not-a-date" }, now)).toThrow(/Invalid --since value/);
  });
});
