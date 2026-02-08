import { describe, expect, it } from "vitest";
import { parseDurationMs } from "./parse-duration.js";

describe("parseDurationMs", () => {
  it("parses bare ms", () => {
    expect(parseDurationMs("10000")).toBe(10_000);
  });

  it("parses seconds suffix", () => {
    expect(parseDurationMs("10s")).toBe(10_000);
  });

  it("parses minutes suffix", () => {
    expect(parseDurationMs("1m")).toBe(60_000);
  });

  it("parses hours suffix", () => {
    expect(parseDurationMs("2h")).toBe(7_200_000);
  });

  it("parses days suffix", () => {
    expect(parseDurationMs("2d")).toBe(172_800_000);
  });

  it("supports decimals", () => {
    expect(parseDurationMs("0.5s")).toBe(500);
  });

  it("throws on empty string", () => {
    expect(() => parseDurationMs("")).toThrow("invalid duration (empty)");
    expect(() => parseDurationMs("  ")).toThrow("invalid duration (empty)");
  });

  it("throws on invalid format", () => {
    expect(() => parseDurationMs("abc")).toThrow("invalid duration: abc");
    expect(() => parseDurationMs("10x")).toThrow("invalid duration: 10x");
    expect(() => parseDurationMs("not-a-number")).toThrow("invalid duration: not-a-number");
  });

  it("throws on negative values", () => {
    expect(() => parseDurationMs("-5")).toThrow("invalid duration: -5");
    expect(() => parseDurationMs("-10s")).toThrow("invalid duration: -10s");
  });

  it("respects custom defaultUnit option", () => {
    expect(parseDurationMs("10", { defaultUnit: "s" })).toBe(10_000);
    expect(parseDurationMs("5", { defaultUnit: "m" })).toBe(300_000);
    expect(parseDurationMs("2", { defaultUnit: "h" })).toBe(7_200_000);
    expect(parseDurationMs("1", { defaultUnit: "d" })).toBe(86_400_000);
    expect(parseDurationMs("100", { defaultUnit: "ms" })).toBe(100);
  });
});
