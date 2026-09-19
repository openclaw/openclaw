// Covers safe-regex checks for risky user-supplied patterns.
import { describe, expect, it } from "vitest";
import {
  compileJsonSchemaPatternRegexDetailed,
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
    [/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`, true],
    [/discord:tail$/, `${"x".repeat(5000)}discord:tail`, true],
    [/discord:tail$/, `${"x".repeat(5000)}telegram:tail`, false],
  ] as const)("checks bounded regex windows for %s", (pattern, input, expected) => {
    expect(testRegexWithBoundedInput(pattern, input)).toBe(expected);
  });

  it("keeps custom adjacent-class redaction patterns on the shared compiler", () => {
    const compiled = compileSafeRegexDetailed("corp-[A-Z]+[A-Z]+");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("corp-ABCDEFGHIJKLMNOP")).toBe(true);
  });

  it("keeps disjoint escaped custom redaction alternatives on the shared compiler", () => {
    const compiled = compileSafeRegexDetailed("corp-(\\x41|BCD)+");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("corp-ABCD")).toBe(true);
    expect(compiled.regex?.test("corp-BCD")).toBe(true);
  });

  it("compiles JSON Schema patterns without trimming significant spaces", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed(" a");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test(" a")).toBe(true);
  });

  it("compiles empty JSON Schema patterns as match-all", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("x")).toBe(true);
    expect(compiled.regex?.test("mode")).toBe(true);
  });

  it("accepts safe disjoint JSON Schema alternatives", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("^(a|bc)+$");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("a")).toBe(true);
    expect(compiled.regex?.test("bc")).toBe(true);
    expect(compiled.regex?.test("abc")).toBe(true);
    expect(compiled.regex?.test("zz")).toBe(false);
  });

  it("accepts disjoint character-class JSON Schema alternatives", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("^([ab]|cd)+$");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("a")).toBe(true);
    expect(compiled.regex?.test("b")).toBe(true);
    expect(compiled.regex?.test("cd")).toBe(true);
    expect(compiled.regex?.test("acd")).toBe(true);
    expect(compiled.regex?.test("zz")).toBe(false);
  });

  it("rejects nested alternatives that share a possible prefix", () => {
    expect(compileJsonSchemaPatternRegexDetailed("^((a|b)|bb)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects semantically overlapping adjacent JSON Schema atoms", () => {
    expect(compileJsonSchemaPatternRegexDetailed("a*[a]*$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegexDetailed("a*[a]*$").reason).toBeNull();
  });

  it("still rejects overlapping JSON Schema alternatives", () => {
    expect(compileJsonSchemaPatternRegexDetailed("(a|aa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("accepts disjoint multi-character JSON Schema groups", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("^(ab)+(cd)+$");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("abcd")).toBe(true);
    expect(compiled.regex?.test("ababcd")).toBe(true);
    expect(compiled.regex?.test("ab")).toBe(false);
    expect(compiled.regex?.test("cd")).toBe(false);
  });

  it("rejects hex-escape alternatives that share a decoded prefix", () => {
    expect(compileJsonSchemaPatternRegexDetailed("^(\\x61|aa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects JSON Schema alternatives that overlap on non-ASCII whitespace", () => {
    expect(compileJsonSchemaPatternRegexDetailed("^(\\s|[\\u00a0][\\u00a0])+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects nested-repetition JSON Schema patterns", () => {
    expect(compileJsonSchemaPatternRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
  });

  it("rejects adjacent unbounded JSON Schema twins without changing the shared compiler", () => {
    expect(compileJsonSchemaPatternRegexDetailed("a*a*$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexDetailed("a*a*$").reason).toBeNull();
  });

  it("rejects unparsed alternating groups adjacent to overlapping repetitions", () => {
    expect(compileJsonSchemaPatternRegexDetailed("^(a|b)+b+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects noncapturing groups with overlapping alternatives", () => {
    expect(compileSafeRegexDetailed("^(?:a|aaa)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(?:a|aaa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects backreference alternatives as unknown prefix languages", () => {
    expect(compileSafeRegexDetailed("^(a)(\\1|aa)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(a)(\\1|aa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("accepts disjoint alternating groups adjacent to a different repetition", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("^(a|b)+c+$");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("ac")).toBe(true);
    expect(compiled.regex?.test("bbc")).toBe(true);
    expect(compiled.regex?.test("ab")).toBe(false);
  });

  it("rejects named backreferences as unknown prefix languages", () => {
    expect(compileSafeRegexDetailed("^(?<x>a)(\\k<x>|aa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^(?<x>a)(\\k<x>|aa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects class backspace as the decoded control character", () => {
    expect(compileSafeRegexDetailed("^([\\b]|\\x08\\x08)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^([\\b]|\\x08\\x08)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping alternatives hidden behind a lookahead", () => {
    expect(compileSafeRegexDetailed("^((?!b)a|aaaa)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^((?!b)a|aaaa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("accepts deterministic adjacent groups that share a first character", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("^(ab)+(ac)+$");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("abac")).toBe(true);
    expect(compiled.regex?.test("ababacab")).toBe(false);
    expect(compiled.regex?.test("ab")).toBe(false);
  });

  it("rejects braced unicode escapes that are identity-plus-quantifier without u", () => {
    expect(compileSafeRegexDetailed("^(\\u{2}|u)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(\\u{2}|u)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects control-escape alternatives that share a decoded prefix", () => {
    expect(compileSafeRegexDetailed("^(\\cA|\\x01\\x01)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^(\\cA|\\x01\\x01)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("keeps lookahead-prefixed deterministic custom redaction alternatives", () => {
    const compiled = compileSafeRegexDetailed("corp-((?=a)ab|acde)+");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("corp-ab")).toBe(true);
    expect(compiled.regex?.test("corp-acde")).toBe(true);
    expect(compiled.regex?.test("corp-aa")).toBe(false);
  });

  it("rejects nested alternatives whose complete sequences overlap adjacent groups", () => {
    expect(compileJsonSchemaPatternRegexDetailed("^((ab|cd)e)+(abe)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects octal escapes that share a decoded prefix with longer alternatives", () => {
    expect(compileSafeRegexDetailed("^(\\141|aaaa)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(\\141|aaaa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects multi-digit backreferences as complete unknown sequences", () => {
    expect(compileSafeRegexDetailed("^(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(\\10|jj)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(
      compileJsonSchemaPatternRegexDetailed("^(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(\\10|jj)+$").reason,
    ).toBe("unsafe-nested-repetition");
  });

  it("rejects overlapping groups that keep complete alternative lengths", () => {
    expect(compileSafeRegexDetailed("^((ab|[a]b)c|abcabc)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^((ab|[a]b)c|abcabc)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overflowed alternative sets that would lose consumed length", () => {
    const pattern = "^(((ab|cd|ef|gh|ij|kl)(mn|op|qr|st|uv|wx)y)|abmnyabmny)+$";
    expect(compileSafeRegexDetailed(pattern).reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed(pattern).reason).toBe("unsafe-nested-repetition");
  });

  it("rejects backreferences that hide overlapping consumed lengths", () => {
    expect(compileSafeRegexDetailed("^(ab)(\\1c|abcabc)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^(ab)(\\1c|abcabc)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("keeps disjoint octal custom redaction alternatives", () => {
    const compiled = compileSafeRegexDetailed("corp-(\\141|BCD)+");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("corp-aBCD")).toBe(true);
    expect(compiled.regex?.test("corp-BCD")).toBe(true);
    expect(compiled.regex?.test("corp-xyz")).toBe(false);
  });

  it("rejects overlapping alternatives hidden by zero-width word boundaries", () => {
    expect(compileSafeRegexDetailed("^(a\\Bb|abab)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(a\\Bb|abab)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping alternatives after a legacy octal leftover literal", () => {
    expect(compileSafeRegexDetailed("^(\\1414c|a4ca4c)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(\\1414c|a4ca4c)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping alternatives inside inline case-flag groups", () => {
    expect(compileSafeRegexDetailed("^((?i:a)|AA)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^((?i:a)|AA)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects class control-escapes that decode like legacy JS", () => {
    expect(compileSafeRegexDetailed("^([\\c_]|\\x1f\\x1f)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^([\\c_]|\\x1f\\x1f)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects non-Unicode property identity-escapes as overlapping literals", () => {
    expect(compileSafeRegexDetailed("^(\\p{L}c|p{L}cp{L}c)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^(\\p{L}c|p{L}cp{L}c)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects Unicode code-point escapes compared against surrogate literals", () => {
    expect(compileSafeRegexDetailed("^(\\u{1F600}|😀😀)+$", "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^(\\u{1F600}|😀😀)+$", "u").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping astral class ranges compared in code-point units", () => {
    expect(compileSafeRegexDetailed("^([😀-🙏]|😀😀)+$", "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^([😀-🙏]|😀😀)+$", "u").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping escaped surrogate-pair alternatives", () => {
    expect(compileSafeRegexDetailed("^(\\uD83D\\uDE00|😀😀)+$", "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^(\\uD83D\\uDE00|😀😀)+$", "u").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping astral class atoms under Unicode case folding", () => {
    expect(compileSafeRegexDetailed("^([𐐀]|𐐨𐐨)+$", "iu").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^([𐐀]|𐐨𐐨)+$", "iu").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping alternatives hidden by malformed control escapes", () => {
    expect(compileSafeRegexDetailed("^(\\c|\\\\c\\\\c)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(\\c|\\\\c\\\\c)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping alternatives hidden by input-boundary assertions", () => {
    expect(compileSafeRegexDetailed("^(\\n^a|\\na\\na)+Z", "m").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^(\\n^a|\\na\\na)+Z", "m").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping nested v-mode character classes", () => {
    expect(compileSafeRegexDetailed("^([[a]b]|aa)+$", "v").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^([[a]b]|aa)+$", "v").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects equal-length overlapping alternatives that carry lookaround assertions", () => {
    expect(compileSafeRegexDetailed("^(a|a(?=a))+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(a|a(?=a))+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping v-mode string-class alternatives", () => {
    expect(compileSafeRegexDetailed("^([\\q{cd}]a|cdacda)+$", "v").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileJsonSchemaPatternRegexDetailed("^([\\q{cd}]a|cdacda)+$", "v").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects overlapping standalone v-mode string-property alternatives", () => {
    expect(compileSafeRegexDetailed("^(\\p{RGI_Emoji_Flag_Sequence}a|🇺🇸a🇺🇸a)+$", "v").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(
      compileJsonSchemaPatternRegexDetailed("^(\\p{RGI_Emoji_Flag_Sequence}a|🇺🇸a🇺🇸a)+$", "v")
        .reason,
    ).toBe("unsafe-nested-repetition");
  });

  it("screens a long literal without nested repetition", { timeout: 2000 }, () => {
    const pattern = "a".repeat(100_000);
    expect(compileSafeRegexDetailed(pattern).reason).toBeNull();
    expect(compileJsonSchemaPatternRegexDetailed(pattern).reason).toBeNull();
  });

  it(
    "rejects long adjacent groups that only differ after the bounded prefix",
    { timeout: 2000 },
    () => {
      const left = "a".repeat(100_000);
      const right = `${"a".repeat(99_999)}b`;
      expect(compileJsonSchemaPatternRegexDetailed(`(${left})*(${right})*`).reason).toBe(
        "unsafe-nested-repetition",
      );
    },
  );
});
