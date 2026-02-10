import { describe, expect, it } from "vitest";
import { parseByteSize } from "./parse-bytes.js";

describe("parseByteSize", () => {
  it("parses bytes with units", () => {
    expect(parseByteSize("10kb")).toBe(10 * 1024);
    expect(parseByteSize("1mb")).toBe(1024 * 1024);
    expect(parseByteSize("2gb")).toBe(2 * 1024 * 1024 * 1024);
  });

  it("parses shorthand units", () => {
    expect(parseByteSize("5k")).toBe(5 * 1024);
    expect(parseByteSize("1m")).toBe(1024 * 1024);
  });

  it("uses default unit when omitted", () => {
    expect(parseByteSize("123")).toBe(123);
  });

  it("rejects invalid values", () => {
    expect(() => parseByteSize("")).toThrow();
    expect(() => parseByteSize("nope")).toThrow();
    expect(() => parseByteSize("-5kb")).toThrow();
  });
});
