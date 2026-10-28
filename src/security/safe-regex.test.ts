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

  it.each([
    ["(a|a)*", "unsafe-ambiguous-alternation"],
    ["(a|a)+", "unsafe-ambiguous-alternation"],
    ["(ab|ab)*", "unsafe-ambiguous-alternation"],
    ["(\\d|\\d)*", "unsafe-ambiguous-alternation"],
  ] as const)("rejects quantified groups with identical alternatives: %s", (pattern, expected) => {
    expect(compileSafeRegexDetailed(pattern).reason).toBe(expected);
    expect(compileSafeRegex(pattern)).toBeNull();
  });

  it("keeps distinct alternatives and unquantified duplicates compilable", () => {
    expect(compileSafeRegex("(a|b)*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("(foo|bar)*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("^(foo|bar)$")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("(a|a)")).toBeInstanceOf(RegExp);
  });

  it.each([
    "corp-(a|a)?([0-9]+)",
    "(a|a){0}",
    "(a|a){1}",
    "(a|a){0,1}",
    "corp-(a|a){2}-[0-9]+",
    "corp-(a|a){2,3}-[0-9]+",
    "(a|a){8}",
  ] as const)(
    "keeps duplicate-alternative groups with a small finite bound compilable: %s",
    (pattern) => {
      expect(compileSafeRegex(pattern)).toBeInstanceOf(RegExp);
    },
  );

  it.each(["(a|a){2,}", "(a|a){9}", "(a|a){2,50}"] as const)(
    "still rejects duplicate-alternative groups with an unbounded or large repeat: %s",
    (pattern) => {
      expect(compileSafeRegexDetailed(pattern).reason).toBe("unsafe-ambiguous-alternation");
    },
  );

  it.each([
    [/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`, true],
    [/discord:tail$/, `${"x".repeat(5000)}discord:tail`, true],
    [/discord:tail$/, `${"x".repeat(5000)}telegram:tail`, false],
  ] as const)("checks bounded regex windows for %s", (pattern, input, expected) => {
    expect(testRegexWithBoundedInput(pattern, input)).toBe(expected);
  });
});
