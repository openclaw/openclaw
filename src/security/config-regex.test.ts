import { describe, expect, it } from "vitest";
import { compileConfigRegex, compileConfigRegexes } from "./config-regex.js";

describe("compileConfigRegex", () => {
  it("returns null for empty pattern", () => {
    expect(compileConfigRegex("")).toBeNull();
    expect(compileConfigRegex("  ")).toBeNull();
  });

  it("compiles a valid pattern", () => {
    const result = compileConfigRegex("foo.*bar");
    expect(result).not.toBeNull();
    expect(result!.regex).toBeInstanceOf(RegExp);
    expect(result!.reason).toBeNull();
  });

  it("compiles with flags", () => {
    const result = compileConfigRegex("hello", "i");
    expect(result).not.toBeNull();
    expect(result!.regex).toBeInstanceOf(RegExp);
    expect(result!.regex!.flags).toContain("i");
  });

  it("rejects an invalid regex", () => {
    const result = compileConfigRegex("[invalid");
    expect(result).not.toBeNull();
    expect(result!.regex).toBeNull();
    expect(result!.reason).toBeTruthy();
  });
});

describe("compileConfigRegexes", () => {
  it("compiles multiple valid patterns", () => {
    const result = compileConfigRegexes(["foo", "bar", "baz"]);
    expect(result.regexes).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
  });

  it("skips empty patterns", () => {
    const result = compileConfigRegexes(["foo", "", "bar"]);
    expect(result.regexes).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it("collects rejected patterns", () => {
    const result = compileConfigRegexes(["foo", "[invalid", "bar"]);
    expect(result.regexes).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].pattern).toBe("[invalid");
    expect(result.rejected[0].reason).toBeTruthy();
  });

  it("handles all empty patterns", () => {
    const result = compileConfigRegexes(["", " ", ""]);
    expect(result.regexes).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });
});
