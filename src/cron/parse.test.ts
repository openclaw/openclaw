import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  it("returns null for undefined input", () => {
    expect(parseAbsoluteTimeMs(undefined)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseAbsoluteTimeMs(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAbsoluteTimeMs("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseAbsoluteTimeMs("   ")).toBeNull();
  });

  it("parses a valid ISO datetime string", () => {
    const result = parseAbsoluteTimeMs("2026-04-21T12:00:00Z");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("number");
  });

  it("parses a valid timestamp number string", () => {
    const now = Date.now();
    const result = parseAbsoluteTimeMs(String(now));
    expect(result).toBe(now);
  });

  it("trims whitespace before parsing", () => {
    const result = parseAbsoluteTimeMs("  2026-04-21T12:00:00Z  ");
    expect(result).not.toBeNull();
  });
});
