import { describe, expect, it } from "vitest";
import { asBoolean, parseBooleanValue } from "./boolean.js";

describe("asBoolean", () => {
  it("returns true for boolean true", () => {
    expect(asBoolean(true)).toBe(true);
  });

  it("returns false for boolean false", () => {
    expect(asBoolean(false)).toBe(false);
  });

  it("returns undefined for string 'true'", () => {
    expect(asBoolean("true")).toBeUndefined();
  });

  it("returns undefined for string 'false'", () => {
    expect(asBoolean("false")).toBeUndefined();
  });

  it("returns undefined for number 1", () => {
    expect(asBoolean(1)).toBeUndefined();
  });

  it("returns undefined for number 0", () => {
    expect(asBoolean(0)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(asBoolean(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(asBoolean(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(asBoolean("")).toBeUndefined();
  });

  it("returns undefined for object", () => {
    expect(asBoolean({})).toBeUndefined();
  });

  it("returns undefined for array", () => {
    expect(asBoolean([])).toBeUndefined();
  });
});

describe("parseBooleanValue", () => {
  describe("boolean input", () => {
    it("returns true for boolean true", () => {
      expect(parseBooleanValue(true)).toBe(true);
    });

    it("returns false for boolean false", () => {
      expect(parseBooleanValue(false)).toBe(false);
    });
  });

  describe("default truthy values", () => {
    it("parses 'true' as true", () => {
      expect(parseBooleanValue("true")).toBe(true);
    });

    it("parses 'TRUE' as true (case insensitive)", () => {
      expect(parseBooleanValue("TRUE")).toBe(true);
    });

    it("parses 'True' as true (case insensitive)", () => {
      expect(parseBooleanValue("True")).toBe(true);
    });

    it("parses '1' as true", () => {
      expect(parseBooleanValue("1")).toBe(true);
    });

    it("parses 'yes' as true", () => {
      expect(parseBooleanValue("yes")).toBe(true);
    });

    it("parses 'YES' as true (case insensitive)", () => {
      expect(parseBooleanValue("YES")).toBe(true);
    });

    it("parses 'on' as true", () => {
      expect(parseBooleanValue("on")).toBe(true);
    });

    it("parses 'ON' as true (case insensitive)", () => {
      expect(parseBooleanValue("ON")).toBe(true);
    });
  });

  describe("default falsy values", () => {
    it("parses 'false' as false", () => {
      expect(parseBooleanValue("false")).toBe(false);
    });

    it("parses 'FALSE' as false (case insensitive)", () => {
      expect(parseBooleanValue("FALSE")).toBe(false);
    });

    it("parses 'False' as false (case insensitive)", () => {
      expect(parseBooleanValue("False")).toBe(false);
    });

    it("parses '0' as false", () => {
      expect(parseBooleanValue("0")).toBe(false);
    });

    it("parses 'no' as false", () => {
      expect(parseBooleanValue("no")).toBe(false);
    });

    it("parses 'NO' as false (case insensitive)", () => {
      expect(parseBooleanValue("NO")).toBe(false);
    });

    it("parses 'off' as false", () => {
      expect(parseBooleanValue("off")).toBe(false);
    });

    it("parses 'OFF' as false (case insensitive)", () => {
      expect(parseBooleanValue("OFF")).toBe(false);
    });
  });

  describe("whitespace handling", () => {
    it("parses ' true ' as true (trims whitespace)", () => {
      expect(parseBooleanValue(" true ")).toBe(true);
    });

    it("parses '\tfalse\n' as false (trims whitespace)", () => {
      expect(parseBooleanValue("\tfalse\n")).toBe(false);
    });

    it("parses '  yes  ' as true (trims whitespace)", () => {
      expect(parseBooleanValue("  yes  ")).toBe(true);
    });
  });

  describe("ambiguous values", () => {
    it("returns undefined for empty string", () => {
      expect(parseBooleanValue("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only string", () => {
      expect(parseBooleanValue("   ")).toBeUndefined();
    });

    it("returns undefined for 'maybe'", () => {
      expect(parseBooleanValue("maybe")).toBeUndefined();
    });

    it("returns undefined for '2'", () => {
      expect(parseBooleanValue("2")).toBeUndefined();
    });

    it("returns undefined for random string", () => {
      expect(parseBooleanValue("random")).toBeUndefined();
    });
  });

  describe("non-string inputs", () => {
    it("returns undefined for null", () => {
      expect(parseBooleanValue(null)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(parseBooleanValue(undefined)).toBeUndefined();
    });

    it("returns undefined for number", () => {
      expect(parseBooleanValue(42)).toBeUndefined();
    });

    it("returns undefined for object", () => {
      expect(parseBooleanValue({})).toBeUndefined();
    });

    it("returns undefined for array", () => {
      expect(parseBooleanValue([])).toBeUndefined();
    });
  });

  describe("custom truthy/falsy values", () => {
    it("accepts custom truthy values", () => {
      expect(parseBooleanValue("enabled", { truthy: ["enabled"] })).toBe(true);
    });

    it("accepts custom falsy values", () => {
      expect(parseBooleanValue("disabled", { falsy: ["disabled"] })).toBe(false);
    });

    it("returns undefined for non-matching custom values", () => {
      expect(parseBooleanValue("true", { truthy: ["enabled"] })).toBeUndefined();
    });

    it("combines custom truthy and falsy values", () => {
      expect(
        parseBooleanValue("enabled", { truthy: ["enabled"], falsy: ["disabled"] }),
      ).toBe(true);
      expect(
        parseBooleanValue("disabled", { truthy: ["enabled"], falsy: ["disabled"] }),
      ).toBe(false);
    });
  });
});
