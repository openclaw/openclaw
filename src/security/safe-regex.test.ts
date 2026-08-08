// Covers safe-regex checks for risky user-supplied patterns.
import { describe, expect, it } from "vitest";
import {
  compileSafeRegex,
  compileJsonSchemaPatternRegex,
  compileJsonSchemaPatternRegexDetailed,
  compileSafeRegexDetailed,
  testRegexWithBoundedInput,
} from "./safe-regex.js";

function expectCompiledRegex(pattern: string, flags?: string): RegExp {
  const re = compileSafeRegex(pattern, flags);
  expect(re).toBeInstanceOf(RegExp);
  if (!re) {
    throw new Error(`Expected ${pattern} to compile safely`);
  }
  return re;
}

describe("safe regex", () => {
  it.each([
    ["(a+)+$", null],
    ["(a|aa)+$", null],
    ["(a|aa){2}$", RegExp],
  ] as const)("compiles %s safely", (pattern, expected) => {
    if (expected === null) {
      expect(compileSafeRegex(pattern)).toBeNull();
      return;
    }
    expect(compileSafeRegex(pattern)).toBeInstanceOf(expected);
  });

  it("compiles common safe filter regex", () => {
    const re = expectCompiledRegex("^agent:.*:discord:");
    expect(re.test("agent:main:discord:channel:123")).toBe(true);
    expect(re.test("agent:main:telegram:channel:123")).toBe(false);
  });

  it("supports explicit flags", () => {
    const re = expectCompiledRegex("token=([A-Za-z0-9]+)", "gi");
    expect("TOKEN=abcd1234".replace(re, "***")).toBe("***");
  });

  it.each([
    ["   ", "empty"],
    ["(a+)+$", "unsafe-nested-repetition"],
    ["(invalid", "invalid-regex"],
    ["^agent:main$", null],
  ] as const)("returns structured reject reason for %s", (pattern, expected) => {
    expect(compileSafeRegexDetailed(pattern).reason).toBe(expected);
  });

  it("preserves exact JSON Schema sources without trimming", () => {
    const space = compileJsonSchemaPatternRegexDetailed(" ");
    expect(space.reason).toBeNull();
    expect(space.regex).toBeInstanceOf(RegExp);
    expect(space.source).toBe(" ");
    expect(space.regex?.test(" ")).toBe(true);
    expect(space.regex?.test("x")).toBe(false);

    const trailing = compileJsonSchemaPatternRegexDetailed("^x ");
    expect(trailing.reason).toBeNull();
    expect(trailing.source).toBe("^x ");
    expect(trailing.regex?.test("x ")).toBe(true);
    // Trimmed "^x" would incorrectly match this key.
    expect(trailing.regex?.test("xy")).toBe(false);

    // Default trim contract still rejects blank sources.
    expect(compileSafeRegexDetailed(" ").reason).toBe("empty");
    expect(compileJsonSchemaPatternRegex(" ")).toBeInstanceOf(RegExp);
  });

  it("still rejects nested repetition with exact-source JSON Schema compile", () => {
    expect(compileJsonSchemaPatternRegexDetailed(" (a+)+$ ").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it.each([
    [/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`, true],
    [/discord:tail$/, `${"x".repeat(5000)}discord:tail`, true],
    [/discord:tail$/, `${"x".repeat(5000)}telegram:tail`, false],
  ] as const)("checks bounded regex windows for %s", (pattern, input, expected) => {
    expect(testRegexWithBoundedInput(pattern, input)).toBe(expected);
  });
});
