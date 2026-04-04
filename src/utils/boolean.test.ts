import { describe, expect, it } from "vitest";
import { parseBooleanValue } from "./boolean.js";

describe("parseBooleanValue", () => {
  it("returns boolean values as-is", () => {
    expect(parseBooleanValue(true)).toBe(true);
    expect(parseBooleanValue(false)).toBe(false);
  });

  it("parses default truthy strings", () => {
    expect(parseBooleanValue("true")).toBe(true);
    expect(parseBooleanValue("TRUE")).toBe(true);
    expect(parseBooleanValue("1")).toBe(true);
    expect(parseBooleanValue("yes")).toBe(true);
    expect(parseBooleanValue("YES")).toBe(true);
    expect(parseBooleanValue("on")).toBe(true);
  });

  it("parses default falsy strings", () => {
    expect(parseBooleanValue("false")).toBe(false);
    expect(parseBooleanValue("FALSE")).toBe(false);
    expect(parseBooleanValue("0")).toBe(false);
    expect(parseBooleanValue("no")).toBe(false);
    expect(parseBooleanValue("off")).toBe(false);
  });

  it("trims whitespace", () => {
    expect(parseBooleanValue("  true  ")).toBe(true);
    expect(parseBooleanValue("  false  ")).toBe(false);
  });

  it("returns undefined for unrecognized strings", () => {
    expect(parseBooleanValue("maybe")).toBeUndefined();
    expect(parseBooleanValue("")).toBeUndefined();
    expect(parseBooleanValue("   ")).toBeUndefined();
  });

  it("returns undefined for other types", () => {
    expect(parseBooleanValue(123 as any)).toBeUndefined();
    expect(parseBooleanValue({} as any)).toBeUndefined();
    expect(parseBooleanValue([] as any)).toBeUndefined();
    expect(parseBooleanValue(null)).toBeUndefined();
    expect(parseBooleanValue(undefined)).toBeUndefined();
  });

  it("allows custom truthy values", () => {
    expect(parseBooleanValue("1", { truthy: ["1", "yup"] })).toBe(true);
    expect(parseBooleanValue("yup", { truthy: ["1", "yup"] })).toBe(true);
  });

  it("allows custom falsy values", () => {
    expect(parseBooleanValue("0", { falsy: ["0", "nope"] })).toBe(false);
    expect(parseBooleanValue("nope", { falsy: ["0", "nope"] })).toBe(false);
  });

  it("custom truthy does not affect falsy defaults", () => {
    expect(parseBooleanValue("false", { truthy: ["1"] })).toBe(false);
  });
});
