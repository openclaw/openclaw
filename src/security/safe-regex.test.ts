import { describe, expect, it } from "vitest";
import {
  compileSafeRegex,
  compileSafeRegexDetailed,
  hasNestedRepetition,
  testRegexWithBoundedInput,
} from "./safe-regex.js";

describe("safe regex", () => {
  it("flags nested repetition patterns", () => {
    expect(hasNestedRepetition("(a+)+$")).toBe(true);
    expect(hasNestedRepetition("(a|aa)+$")).toBe(true);
    expect(hasNestedRepetition("^(?:foo|bar)$")).toBe(false);
    expect(hasNestedRepetition("^(ab|cd)+$")).toBe(false);
  });

  it("rejects unsafe nested repetition during compile", () => {
    expect(compileSafeRegex("(a+)+$")).toBeNull();
    expect(compileSafeRegex("(a|aa)+$")).toBeNull();
    expect(compileSafeRegex("(a|aa){2}$")).toBeInstanceOf(RegExp);
  });

  it("compiles common safe filter regex", () => {
    const re = compileSafeRegex("^agent:.*:discord:");
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.test("agent:main:discord:channel:123")).toBe(true);
    expect(re?.test("agent:main:telegram:channel:123")).toBe(false);
  });

  it("supports explicit flags", () => {
    const re = compileSafeRegex("token=([A-Za-z0-9]+)", "gi");
    expect(re).toBeInstanceOf(RegExp);
    expect("TOKEN=abcd1234".replace(re as RegExp, "***")).toBe("***");
  });

  it("returns structured reject reasons", () => {
    expect(compileSafeRegexDetailed("   ").reason).toBe("empty");
    expect(compileSafeRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexDetailed("(invalid").reason).toBe("invalid-regex");
    expect(compileSafeRegexDetailed("^agent:main$").reason).toBeNull();
  });

  it("checks bounded regex windows for long inputs", () => {
    expect(
      testRegexWithBoundedInput(/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`),
    ).toBe(true);
    expect(testRegexWithBoundedInput(/discord:tail$/, `${"x".repeat(5000)}discord:tail`)).toBe(
      true,
    );
    expect(testRegexWithBoundedInput(/discord:tail$/, `${"x".repeat(5000)}telegram:tail`)).toBe(
      false,
    );
  });
});
