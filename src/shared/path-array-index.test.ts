import { describe, expect, it } from "vitest";
import { parseConfigPathArrayIndex } from "./path-array-index.js";

describe("parseConfigPathArrayIndex", () => {
  it("parses the zero index", () => {
    expect(parseConfigPathArrayIndex("0")).toBe(0);
  });

  it("accepts indexes up to the max bound", () => {
    expect(parseConfigPathArrayIndex("100000")).toBe(100000);
  });

  it("rejects indexes exceeding the max bound", () => {
    expect(parseConfigPathArrayIndex("100001")).toBeUndefined();
  });

  it("rejects leading zero indexes as non-canonical", () => {
    expect(parseConfigPathArrayIndex("00")).toBeUndefined();
    expect(parseConfigPathArrayIndex("01")).toBeUndefined();
  });

  it("rejects negative indexes", () => {
    expect(parseConfigPathArrayIndex("-1")).toBeUndefined();
    expect(parseConfigPathArrayIndex("-0")).toBeUndefined();
  });

  it("rejects empty or non-numeric segments", () => {
    expect(parseConfigPathArrayIndex("")).toBeUndefined();
    expect(parseConfigPathArrayIndex("abc")).toBeUndefined();
  });

  it("rejects decimals, whitespace, and special characters", () => {
    expect(parseConfigPathArrayIndex("1.5")).toBeUndefined();
    expect(parseConfigPathArrayIndex(" 5")).toBeUndefined();
    expect(parseConfigPathArrayIndex("5 ")).toBeUndefined();
    expect(parseConfigPathArrayIndex("1e2")).toBeUndefined();
  });
});
