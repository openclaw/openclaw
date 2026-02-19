import { describe, expect, it } from "vitest";
import { isPlainObject } from "./plain-object.js";

describe("isPlainObject", () => {
  it("accepts plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("rejects non-plain values", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(/re/)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });
});
