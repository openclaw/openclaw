import { describe, expect, it } from "vitest";
import { parseTimeoutMs } from "./parse-timeout";

describe("parseTimeoutMs", () => {
  it("returns undefined for nullish and blank values", () => {
    expect(parseTimeoutMs(undefined)).toBeUndefined();
    expect(parseTimeoutMs(null)).toBeUndefined();
    expect(parseTimeoutMs("")).toBeUndefined();
    expect(parseTimeoutMs("   ")).toBeUndefined();
  });

  it("parses integer values from number, bigint, and trimmed strings", () => {
    expect(parseTimeoutMs(0)).toBe(0);
    expect(parseTimeoutMs(1500)).toBe(1500);
    expect(parseTimeoutMs(1500n)).toBe(1500);
    expect(parseTimeoutMs(" 1500 ")).toBe(1500);
    expect(parseTimeoutMs("+42")).toBe(42);
    expect(parseTimeoutMs("-42")).toBe(-42);
  });

  it("rejects non-integer or mixed strings", () => {
    expect(parseTimeoutMs("1500ms")).toBeUndefined();
    expect(parseTimeoutMs("12.5")).toBeUndefined();
    expect(parseTimeoutMs("1e3")).toBeUndefined();
    expect(parseTimeoutMs("0x10")).toBeUndefined();
    expect(parseTimeoutMs("12_000")).toBeUndefined();
  });

  it("rejects non-safe integers and non-finite values", () => {
    expect(parseTimeoutMs(Number.NaN)).toBeUndefined();
    expect(parseTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseTimeoutMs(12.5)).toBeUndefined();
    expect(parseTimeoutMs(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(parseTimeoutMs(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBeUndefined();
  });
});
