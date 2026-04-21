import { describe, expect, it } from "vitest";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "./string-coerce.js";

describe("normalizeOptionalLowercaseString", () => {
  it("returns undefined for undefined", () => {
    expect(normalizeOptionalLowercaseString(undefined)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(normalizeOptionalLowercaseString(null)).toBeUndefined();
  });

  it("returns undefined for non-string values", () => {
    expect(normalizeOptionalLowercaseString(123)).toBeUndefined();
    expect(normalizeOptionalLowercaseString(true)).toBeUndefined();
    expect(normalizeOptionalLowercaseString({})).toBeUndefined();
    expect(normalizeOptionalLowercaseString([])).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeOptionalLowercaseString("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normalizeOptionalLowercaseString("   ")).toBeUndefined();
    expect(normalizeOptionalLowercaseString("\t\n")).toBeUndefined();
  });

  it("returns lowercase trimmed string for valid input", () => {
    expect(normalizeOptionalLowercaseString("  Hello World  ")).toBe("hello world");
    expect(normalizeOptionalLowercaseString("ANNOUNCE")).toBe("announce");
    expect(normalizeOptionalLowercaseString("Webhook")).toBe("webhook");
  });
});

describe("normalizeOptionalString", () => {
  it("returns undefined for undefined", () => {
    expect(normalizeOptionalString(undefined)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(normalizeOptionalString(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeOptionalString("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normalizeOptionalString("   ")).toBeUndefined();
  });

  it("returns trimmed string for valid input", () => {
    expect(normalizeOptionalString("  hello  ")).toBe("hello");
    expect(normalizeOptionalString("world")).toBe("world");
  });
});
