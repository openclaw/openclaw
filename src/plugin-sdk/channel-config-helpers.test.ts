import { describe, expect, it } from "vitest";
import { mapAllowFromEntries, resolveOptionalConfigString } from "./channel-config-helpers.js";

describe("mapAllowFromEntries", () => {
  it("coerces allowFrom entries to strings", () => {
    expect(mapAllowFromEntries(["user", 42, null])).toEqual(["user", "42", "null"]);
  });

  it("returns empty list for missing input", () => {
    expect(mapAllowFromEntries(undefined)).toEqual([]);
  });
});

describe("resolveOptionalConfigString", () => {
  it("trims and returns string values", () => {
    expect(resolveOptionalConfigString("  room:123  ")).toBe("room:123");
  });

  it("coerces numeric values", () => {
    expect(resolveOptionalConfigString(123)).toBe("123");
  });

  it("returns undefined for empty values", () => {
    expect(resolveOptionalConfigString("   ")).toBeUndefined();
    expect(resolveOptionalConfigString(undefined)).toBeUndefined();
  });
});
