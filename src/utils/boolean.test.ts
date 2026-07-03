import { describe, expect, it } from "vitest";
import { asBoolean, parseBooleanValue } from "./boolean.js";

describe("asBoolean", () => {
  it("returns the value for actual booleans", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
  });

  it("returns undefined for non-boolean values", () => {
    expect(asBoolean("true")).toBeUndefined();
    expect(asBoolean("false")).toBeUndefined();
    expect(asBoolean(1)).toBeUndefined();
    expect(asBoolean(0)).toBeUndefined();
    expect(asBoolean(null)).toBeUndefined();
    expect(asBoolean(undefined)).toBeUndefined();
    expect(asBoolean("yes")).toBeUndefined();
  });
});

describe("parseBooleanValue", () => {
  it("parses boolean values directly", () => {
    expect(parseBooleanValue(true)).toBe(true);
    expect(parseBooleanValue(false)).toBe(false);
  });

  it("parses default truthy string literals", () => {
    expect(parseBooleanValue("true")).toBe(true);
    expect(parseBooleanValue("TRUE")).toBe(true);
    expect(parseBooleanValue("1")).toBe(true);
    expect(parseBooleanValue("yes")).toBe(true);
    expect(parseBooleanValue("on")).toBe(true);
  });

  it("parses default falsy string literals", () => {
    expect(parseBooleanValue("false")).toBe(false);
    expect(parseBooleanValue("FALSE")).toBe(false);
    expect(parseBooleanValue("0")).toBe(false);
    expect(parseBooleanValue("no")).toBe(false);
    expect(parseBooleanValue("off")).toBe(false);
  });

  it("returns undefined for unrecognized strings", () => {
    expect(parseBooleanValue("maybe")).toBeUndefined();
    expect(parseBooleanValue("")).toBeUndefined();
  });

  it("returns undefined for non-string non-boolean values", () => {
    expect(parseBooleanValue(42)).toBeUndefined();
    expect(parseBooleanValue(null)).toBeUndefined();
    expect(parseBooleanValue(undefined)).toBeUndefined();
    expect(parseBooleanValue({})).toBeUndefined();
  });

  it("supports custom truthy and falsy literals", () => {
    expect(parseBooleanValue("enabled", { truthy: ["enabled"] })).toBe(true);
    expect(parseBooleanValue("disabled", { falsy: ["disabled"] })).toBe(false);
  });
});
