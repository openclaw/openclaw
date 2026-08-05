// Covers safe-regex checks for risky user-supplied patterns.
import { describe, expect, it } from "vitest";
import {
  compileSafeRegex,
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
    ["(a|a)+$", null],
    ["(?:a|aa)+$", null],
    ["(?:a|a)+$", null],
    ["(?:(a|a))+$", null],
    ["(aa|a.)+$", null],
    ["([ab]|a.)+$", null],
    ["(a|b)+$", RegExp],
    ["(?:a|b)+$", RegExp],
    ["(aa|bb)+$", RegExp],
    ["(a|aa){2}$", RegExp],
    ["(a|a){2}$", RegExp],
    ["(aa|a.){2}$", RegExp],
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

  it("preserves nonblank source bytes during analysis and compilation", () => {
    const escapedSpace = String.raw`\ `;
    const escapedResult = compileSafeRegexDetailed(escapedSpace);
    expect(escapedResult.source).toBe(escapedSpace);
    expect(escapedResult.regex?.test(" ")).toBe(true);

    const padded = expectCompiledRegex(" a ");
    expect(padded.test(" a ")).toBe(true);
    expect(padded.test("a")).toBe(false);
  });

  it.each([
    ["   ", "empty"],
    ["(a+)+$", "unsafe-nested-repetition"],
    ["(a|a)+$", "unsafe-nested-repetition"],
    ["(aa|a.)+$", "unsafe-nested-repetition"],
    ["(invalid", "invalid-regex"],
    ["^agent:main$", null],
  ] as const)("returns structured reject reason for %s", (pattern, expected) => {
    expect(compileSafeRegexDetailed(pattern).reason).toBe(expected);
  });

  it.each([
    [/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`, true],
    [/discord:tail$/, `${"x".repeat(5000)}discord:tail`, true],
    [/discord:tail$/, `${"x".repeat(5000)}telegram:tail`, false],
  ] as const)("checks bounded regex windows for %s", (pattern, input, expected) => {
    expect(testRegexWithBoundedInput(pattern, input)).toBe(expected);
  });
});
