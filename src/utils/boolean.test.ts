// Covers asBoolean and parseBooleanValue boundary behavior for config, env, and plugin SDK parsing.
import { describe, expect, it } from "vitest";
import { asBoolean, parseBooleanValue } from "./boolean.js";

describe("asBoolean", () => {
  it("returns boolean values as-is", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
  });

  it("returns undefined for string look-alikes", () => {
    expect(asBoolean("true")).toBeUndefined();
    expect(asBoolean("false")).toBeUndefined();
  });

  it("returns undefined for numbers", () => {
    expect(asBoolean(0)).toBeUndefined();
    expect(asBoolean(1)).toBeUndefined();
  });

  it("returns undefined for null and undefined", () => {
    expect(asBoolean(null)).toBeUndefined();
    expect(asBoolean(undefined)).toBeUndefined();
  });

  it("returns undefined for Boolean object wrappers", () => {
    // new Boolean(true) has typeof "object", not "boolean"
    expect(asBoolean(new Boolean(true) as unknown)).toBeUndefined();
    expect(asBoolean(new Boolean(false) as unknown)).toBeUndefined();
  });
});

describe("parseBooleanValue", () => {
  it("returns booleans as-is", () => {
    expect(parseBooleanValue(true)).toBe(true);
    expect(parseBooleanValue(false)).toBe(false);
  });

  it("parses default truthy strings", () => {
    expect(parseBooleanValue("true")).toBe(true);
    expect(parseBooleanValue("1")).toBe(true);
    expect(parseBooleanValue("yes")).toBe(true);
    expect(parseBooleanValue("on")).toBe(true);
  });

  it("parses default falsy strings", () => {
    expect(parseBooleanValue("false")).toBe(false);
    expect(parseBooleanValue("0")).toBe(false);
    expect(parseBooleanValue("no")).toBe(false);
    expect(parseBooleanValue("off")).toBe(false);
  });

  it("handles case-insensitivity via normalizeOptionalLowercaseString", () => {
    expect(parseBooleanValue("TRUE")).toBe(true);
    expect(parseBooleanValue("Yes")).toBe(true);
    expect(parseBooleanValue("ON")).toBe(true);
    expect(parseBooleanValue("FALSE")).toBe(false);
    expect(parseBooleanValue("No")).toBe(false);
    expect(parseBooleanValue("OFF")).toBe(false);
  });

  it("handles whitespace trimming via normalizeOptionalLowercaseString", () => {
    expect(parseBooleanValue(" true ")).toBe(true);
    expect(parseBooleanValue("  yes")).toBe(true);
    expect(parseBooleanValue("1\t")).toBe(true);
    expect(parseBooleanValue(" false ")).toBe(false);
    expect(parseBooleanValue("\tno")).toBe(false);
  });

  it("returns undefined for ambiguous or unsupported strings", () => {
    expect(parseBooleanValue("maybe")).toBeUndefined();
    expect(parseBooleanValue("")).toBeUndefined();
    expect(parseBooleanValue("   ")).toBeUndefined();
  });

  it("returns undefined for non-boolean, non-string values", () => {
    expect(parseBooleanValue(1)).toBeUndefined();
    expect(parseBooleanValue(0)).toBeUndefined();
    expect(parseBooleanValue(null)).toBeUndefined();
    expect(parseBooleanValue(undefined)).toBeUndefined();
    expect(parseBooleanValue({})).toBeUndefined();
  });

  it("respects custom truthy and falsy lists", () => {
    // Replace defaults, "on" not in custom lists → undefined
    expect(parseBooleanValue("on", { truthy: ["true"], falsy: ["false"] })).toBeUndefined();
    // Custom truthy
    expect(parseBooleanValue("yes", { truthy: ["yes"], falsy: ["no"] })).toBe(true);
    // Custom falsy
    expect(parseBooleanValue("no", { truthy: ["yes"], falsy: ["no"] })).toBe(false);
  });

  it("returns undefined when truthy and falsy lists are both empty", () => {
    expect(parseBooleanValue("true", { truthy: [], falsy: [] })).toBeUndefined();
    expect(parseBooleanValue("false", { truthy: [], falsy: [] })).toBeUndefined();
  });

  it("prioritizes truthy match over falsy when a value appears in both", () => {
    // "yes" is in both truthy and falsy → checked truthy first → true
    expect(parseBooleanValue("yes", { truthy: ["yes"], falsy: ["yes"] })).toBe(true);
  });
});
