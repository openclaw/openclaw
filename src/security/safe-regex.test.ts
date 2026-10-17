// Covers safe-regex checks for risky user-supplied patterns.
import { describe, expect, it } from "vitest";
import { DEFAULT_REDACT_PATTERNS } from "../logging/redact-patterns.js";
import { tokenizePattern } from "./safe-regex-tokens.js";
import {
  compileSafeRegex,
  compileSafeRegexDetailed,
  compileSafeRegexForExec,
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
    ["(\\w|\\d)+$", null],
    ["^(\\w|\\d)+$", null],
    ["([\\w]|[-.])+$", RegExp],
    ["([a-z]|[0-9])+$", RegExp],
    ["(?:a|b)+$", RegExp],
    ["(aa|bb)+$", RegExp],
    ["^(ab|ac)+$", RegExp],
    ["(ab|[c]d)+$", RegExp],
    ["corp-(ab|[c]d)+", RegExp],
    ["^(ab|[a]b)+$", null],
    [String.raw`^(\141\x61|aaaa)+$`, null],
    ["^((ab)|(cd))+$", RegExp],
    ["corp-((ab)|(cd))+", RegExp],
    ["corp-((ab|cd)e|(fg|hi)j)+", RegExp],
    ["^((ab|cd)e|(fg|hi)j)+$", RegExp],
    ["^((ab|cd)e|(abe))+$", null],
    ["^(a|[b]c)+$", RegExp],
    ["^(a|[a]c)+$", null],
    [String.raw`^(\u00E9a|[é]a)+$`, null],
    ["^((a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)x|zx)+$", RegExp],
    [String.raw`^(\x24a|[$]a)+$`, null],
    [String.raw`corp-(\.a|[b]a)+`, RegExp],
    [String.raw`^(\400| 0)+$`, null],
    // Disjoint unequal-length alts under + are not ReDoS (not length-diff alone).
    ["(a|bc)+$", RegExp],
    ["^(?:a|bc)+$", RegExp],
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

  it("rejects ignore-case overlapping alternatives with locale-independent folding", () => {
    // JS `i` matching is not process-locale dependent; Turkish locale must not
    // accept ^(I|i)+$ as disjoint.
    expect(compileSafeRegex("^(I|i)+$", "i")).toBeNull();
    expect(compileSafeRegexDetailed("^(I|i)+$", "i").reason).toBe("unsafe-nested-repetition");
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

  it("trims shared compiler source (whitespace contract for non-exec callers)", () => {
    const padded = compileSafeRegexDetailed(" a ");
    expect(padded.source).toBe("a");
    expect(padded.regex?.source).toBe("a");
    expect(padded.regex?.test("a")).toBe(true);

    // Shared trim turns "\ " into "\", which is invalid — that is intentional.
    // Exec path (compileExecArgPattern) keeps the original source.
    const escapedSpace = String.raw`\ `;
    const escapedResult = compileSafeRegexDetailed(escapedSpace);
    expect(escapedResult.reason).toBe("invalid-regex");
    expect(escapedResult.source).toBe("\\");
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

  it("shared compiler accepts disjoint unprobed Unicode classes", () => {
    // Group-mention style alts must not be banned by a shared finite-probe fallback.
    const pattern = "^(?:[猫]|[犬])+$";
    expect(compileSafeRegexDetailed(pattern).reason).toBeNull();
    expect(compileSafeRegex(pattern)).toBeInstanceOf(RegExp);
  });

  it("exec-style fail-closed rejects unprobed Unicode single-token alts", () => {
    const pattern = String.raw`^(?:[\u0100]|\u0100)+$`;
    const shared = compileSafeRegexDetailed(pattern);
    expect(shared.reason).toBe("unsafe-nested-repetition");
    expect(shared.regex).toBeNull();
    const execMode = compileSafeRegexForExec(pattern);
    expect(execMode.reason).toBe("unsafe-nested-repetition");
    expect(execMode.regex).toBeNull();
    expect(compileSafeRegexDetailed("^(?:[猫]|[犬])+$").reason).toBeNull();
  });

  it("rejects adjacent Unicode property repeats as one atom", () => {
    const overlapping = String.raw`^\p{L}*\p{L}*\p{L}*z$`;
    const tokens = tokenizePattern(overlapping, "u").filter(
      (token) => token.kind === "simple-token",
    );
    expect(tokens.map((token) => token.source)).toEqual([
      "^",
      String.raw`\p{L}`,
      String.raw`\p{L}`,
      String.raw`\p{L}`,
      "z",
      "$",
    ]);
    expect(compileSafeRegex(overlapping, "u")).toBeNull();
    expect(compileSafeRegexDetailed(overlapping, "u").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexForExec(overlapping, "u").regex).toBeNull();
    expect(compileSafeRegex(String.raw`\P{L}*\P{L}*`, "u")).toBeNull();
    expect(compileSafeRegexDetailed(String.raw`\p{L}*\p{Ll}*`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegex(String.raw`^\p{L}*\p{N}*z$`, "u")).toBeInstanceOf(RegExp);
    expect(
      tokenizePattern(String.raw`\p{(a+)+}`).some((token) => token.kind === "group-open"),
    ).toBe(true);
    expect(compileSafeRegexDetailed(String.raw`\p{(a+)+}`).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexForExec(String.raw`\p{(a+)+}`).regex).toBeNull();
    expect(compileSafeRegexDetailed(String.raw`\P{(a|aa)+}`).reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegexDetailed(String.raw`\u0041*\u0041*`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegexDetailed(String.raw`\x41*\x41*`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(
      compileSafeRegexDetailed(String.raw`\p{Script=Latin}*\p{Script=Latin}*`, "u").reason,
    ).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexDetailed(String.raw`\p{Script=Arabic}*\p{sc=Arab}*`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(
      compileSafeRegexForExec(String.raw`\p{Script=Arabic}*\p{sc=Arab}*`, "u").regex,
    ).toBeNull();
    expect(compileSafeRegexDetailed(String.raw`(\p{Script=Arabic}|\p{sc=Arab})+`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(
      compileSafeRegexForExec(String.raw`(\p{Script=Arabic}|\p{sc=Arab})+`, "u").regex,
    ).toBeNull();
  });

  it("rejects adjacent overlapping unbounded repeats (a*a*)", () => {
    expect(compileSafeRegex("^a*a*a*a*a*a*a*a*a*a*b$")).toBeNull();
    expect(compileSafeRegexDetailed("^a*a*a*a*a*a*a*a*a*a*b$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegex("a*a*")).toBeNull();
    expect(compileSafeRegex("(a)*(a)*")).toBeNull();
    expect(compileSafeRegex("(a*)(a*)")).toBeNull();
    expect(compileSafeRegex("a*(?:)a*")).toBeNull();
    expect(compileSafeRegex("[ab]*[ab]*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("[猫]*[猫]*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec("[ab]*[ab]*").regex).toBeNull();
    expect(compileSafeRegexForExec("[猫]*[猫]*").regex).toBeNull();
  });

  it("rejects adjacent unbounded groups whose complete branch unions overlap", () => {
    // Last-branch-only comparison would treat (a|b)* as "b" and (b|c)* as "c".
    expect(compileSafeRegex("^(a|b)*(b|c)*z$")).toBeNull();
    expect(compileSafeRegexDetailed("^(a|b)*(b|c)*z$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex("^(a|b)*(b|c)*(b|d)*z$")).toBeNull();
    expect(compileSafeRegex("^(?:a|b)*(?:b|c)*z$")).toBeNull();
    expect(compileSafeRegex("^(a|(b))*(b|(c))*z$")).toBeNull();
    expect(compileSafeRegex("^(a|b)*(?:)*(b|c)*z$")).toBeNull();
    expect(compileSafeRegex("^(a|b)*(?:)?(b|c)*z$")).toBeNull();
    expect(compileSafeRegex("((a|b))*((b|c))*")).toBeNull();
    expect(compileSafeRegex("(?:(?:a|b))*(?:(?:b|c))*")).toBeNull();
    expect(compileSafeRegex("(a|b)*((b|c))*")).toBeNull();
    expect(compileSafeRegex("((a|b)*)((b|c)*)")).toBeNull();
    expect(compileSafeRegex("(a*)a*")).toBeNull();
    expect(compileSafeRegex("a*(a*)")).toBeNull();
    expect(compileSafeRegex("^(a|b)*(?=b)(b|c)*z$")).toBeNull();
    expect(compileSafeRegexForExec("^(a|b)*(b|c)*z$").regex).toBeNull();
    expect(compileSafeRegexForExec("((a|b))*((b|c))*").regex).toBeNull();
  });

  it("accepts adjacent unbounded groups whose complete branch unions are disjoint", () => {
    expect(compileSafeRegex("^(a|x)*(b|y)*z$")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("^(a|bc)*(d|ef)*z$")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexDetailed("^(a|x)*(b|y)*z$").reason).toBeNull();
  });

  it("preserves complete languages for non-alternating grouped sequences", () => {
    // Last-token fallback would reduce (ab)* and (cb)* to b vs b and reject.
    const grouped = expectCompiledRegex("^(ab)*(cb)*$");
    expect(grouped.test("abcb")).toBe(true);
    expect(grouped.test("ab")).toBe(true);
    expect(grouped.test("cb")).toBe(true);
    expect(compileSafeRegexDetailed("^(ab)*(cb)*$").reason).toBeNull();
    expect(compileSafeRegexForExec("^(ab)*(cb)*$").regex).toBeInstanceOf(RegExp);
    // Repeated complete sequence is still a twin.
    expect(compileSafeRegex("^(ab)*(ab)*$")).toBeNull();
    expect(compileSafeRegexDetailed("^(ab)*(ab)*$").reason).toBe("unsafe-nested-repetition");
    // Wrapping groups still flatten inner unions.
    expect(compileSafeRegex("((a|b))*((b|c))*")).toBeNull();
  });

  it("accepts adjacent repeats that do not overlap and non-adjacent twins", () => {
    expect(compileSafeRegex("a*b*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("[ab]*[cd]*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("a*xa*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("a*a")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("a{1,3}a{1,3}")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("[猫]*[犬]*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec("[猫]*[犬]*").regex).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexDetailed("[猫]*[犬]*").reason).toBeNull();
  });

  it("rejects overlapping unbounded repeats across a zero-minimum separator", () => {
    // `x?` / `{0,n}` / `x*` can be omitted, so a*…a* is still adjacent on that path.
    expect(compileSafeRegex("a*x?a*")).toBeNull();
    expect(compileSafeRegex("^a*x?a*x?a*x?a*b$")).toBeNull();
    expect(compileSafeRegexDetailed("^a*x?a*x?a*x?a*b$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex("a*x{0,3}a*")).toBeNull();
    expect(compileSafeRegex("a*x{0,}a*")).toBeNull();
    expect(compileSafeRegex("a*x*a*")).toBeNull();
    expect(compileSafeRegex("a*b*a*")).toBeNull();
    expect(compileSafeRegex("a*(x)?a*")).toBeNull();
    expect(compileSafeRegex("a*(x*)a*")).toBeNull();
    expect(compileSafeRegex("a*(x?)a*")).toBeNull();
    expect(compileSafeRegex("a*(?:x)?a*")).toBeNull();
    expect(compileSafeRegex("a*[x]?a*")).toBeNull();
    expect(compileSafeRegex("a*a?a*")).toBeNull();
    expect(compileSafeRegexForExec("^a*x?a*x?a*x?a*b$").regex).toBeNull();
    expect(compileSafeRegex("a*x?b*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("a*x+a*")).toBeInstanceOf(RegExp);
  });

  it("keeps custom redaction adjacent class repeats on the shared compiler", () => {
    expect(compileSafeRegexDetailed("corp-[A-Z]+[A-Z]+").reason).toBeNull();
    expect(compileSafeRegex("corp-[A-Z]+[A-Z]+")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec("corp-[A-Z]+[A-Z]+").regex).toBeNull();
  });

  it("accepts disjoint mixed alternatives of equal consumed length", () => {
    const mixed = "corp-(ab|[c]d)+";
    const grouped = "^(ab|[c]d)+$";
    expect(compileSafeRegexDetailed(mixed).reason).toBeNull();
    expect(compileSafeRegex(mixed)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(mixed).regex).toBeInstanceOf(RegExp);
    const compiled = expectCompiledRegex(grouped);
    expect(compiled.test("abcd")).toBe(true);
    expect(compiled.test("cdab")).toBe(true);
    expect(compileSafeRegexForExec(grouped).regex).toBeInstanceOf(RegExp);
    expect(compileSafeRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexForExec("(aa|a.)+$").regex).toBeNull();
  });

  it("rejects overlapping octal and hex alternatives of unequal native width", () => {
    // No-flag \141 is octal `a`; \x61 is hex `a`. Native language is (aa|aaaa)+.
    const overlapping = String.raw`^(\141\x61|aaaa)+$`;
    const tokens = tokenizePattern(overlapping).filter((token) => token.kind === "simple-token");
    expect(tokens.map((token) => token.source)).toEqual([
      "^",
      String.raw`\141`,
      String.raw`\x61`,
      "a",
      "a",
      "a",
      "a",
      "$",
    ]);
    expect(compileSafeRegexDetailed(overlapping).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(overlapping)).toBeNull();
    expect(compileSafeRegexForExec(overlapping).regex).toBeNull();
  });

  it("accepts disjoint nested alternatives of equal consumed length", () => {
    const nested = "corp-((ab|cd)e|(fg|hi)j)+";
    const grouped = "^((ab|cd)e|(fg|hi)j)+$";
    expect(compileSafeRegexDetailed(nested).reason).toBeNull();
    expect(compileSafeRegex(nested)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(nested).regex).toBeInstanceOf(RegExp);
    const compiled = expectCompiledRegex(grouped);
    expect(compiled.test("abehij")).toBe(true);
    expect(compiled.test("cdefgj")).toBe(true);
    expect(compileSafeRegexDetailed("^((ab|cd)e|(abe))+$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexForExec("^((ab|cd)e|(abe))+$").regex).toBeNull();
  });

  it("rejects no-flag property identity alternatives that native matching overlaps", () => {
    // Without u/v, `\p{L}` is identity `p` plus `{L}`, so this is `(p{L}a|p{L}ap{L}a)+`.
    const overlapping = String.raw`^(\p{L}a|p\{L\}ap\{L\}a)+$`;
    const tokens = tokenizePattern(overlapping)
      .filter((token) => token.kind === "simple-token")
      .map((token) => token.source);
    expect(tokens).toEqual([
      "^",
      String.raw`\p`,
      "{",
      "L",
      "}",
      "a",
      "p",
      String.raw`\{`,
      "L",
      String.raw`\}`,
      "a",
      "p",
      String.raw`\{`,
      "L",
      String.raw`\}`,
      "a",
      "$",
    ]);
    expect(compileSafeRegexDetailed(overlapping).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(overlapping)).toBeNull();
    expect(compileSafeRegexForExec(overlapping).regex).toBeNull();
    expect(compileSafeRegexDetailed(overlapping, "u").reason).toBeNull();
  });

  it("accepts long disjoint alternatives past the analysis atom cap", () => {
    const longDisjoint = `^([a]${"b".repeat(32)}|[c]${"d".repeat(32)})+$`;
    expect(compileSafeRegexDetailed(longDisjoint).reason).toBeNull();
    expect(compileSafeRegex(longDisjoint)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(longDisjoint).regex).toBeInstanceOf(RegExp);
    const compiled = expectCompiledRegex(longDisjoint);
    expect(compiled.test(`a${"b".repeat(32)}c${"d".repeat(32)}`)).toBe(true);
    expect(compileSafeRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
  });

  it("rejects decoded non-ASCII literals that overlap without unicode flags", () => {
    // `\u00E9` is é. Emitting `\u{e9}` for overlap probes drops `u`, so the
    // left atom cannot match `[é]` and identical branches look disjoint.
    const overlapping = String.raw`^(\u00E9a|[é]a)+$`;
    expect(compileSafeRegexDetailed(overlapping).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(overlapping)).toBeNull();
    expect(compileSafeRegexForExec(overlapping).regex).toBeNull();
  });

  it("rejects overlapping repetitions after prefix truncation", () => {
    const unit = `[a]${"a".repeat(32)}`;
    const overlapping = `^(${unit}|${unit}${unit})+$`;
    expect(compileSafeRegexDetailed(overlapping).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(overlapping)).toBeNull();
    expect(compileSafeRegexForExec(overlapping).regex).toBeNull();
    const longerUnit = `[a]${"a".repeat(33)}`;
    const longerOverlapping = `^(${longerUnit}|${longerUnit}${longerUnit})+$`;
    expect(compileSafeRegexDetailed(longerOverlapping).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(longerOverlapping)).toBeNull();
    expect(compileSafeRegexForExec(longerOverlapping).regex).toBeNull();
    expect(compileSafeRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
  });

  it("preserves disjoint alternatives when expansion reaches its sequence limit", () => {
    const seventeenWay = "^((a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)x|zx)+$";
    expect(compileSafeRegexDetailed(seventeenWay).reason).toBeNull();
    expect(compileSafeRegex(seventeenWay)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(seventeenWay).regex).toBeInstanceOf(RegExp);
    const compiled = expectCompiledRegex(seventeenWay);
    expect(compiled.test("axzx")).toBe(true);
    expect(compiled.test("zxqx")).toBe(true);
    expect(compileSafeRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
  });

  it("rejects expansion overflow that would skip comparing a prefix language", () => {
    // 17 inner alternatives overflow the sequence cap, so `ax` must still be
    // compared with `axax` instead of compiling as safe.
    const overflowing = "^((a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)x|axax)+$";
    expect(compileSafeRegexDetailed(overflowing).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(overflowing)).toBeNull();
    expect(compileSafeRegexForExec(overflowing).regex).toBeNull();
    const twoCharOverflow = "^((ax|bx|cx|dx|ex|fx|gx|hx|ix|jx|kx|lx|mx|nx|ox|px|qx)|axax)+$";
    expect(compileSafeRegexDetailed(twoCharOverflow).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(twoCharOverflow)).toBeNull();
    expect(compileSafeRegexForExec(twoCharOverflow).regex).toBeNull();
    const twoCharDisjoint = "^((ax|bx|cx|dx|ex|fx|gx|hx|ix|jx|kx|lx|mx|nx|ox|px|qx)|zx)+$";
    expect(compileSafeRegexDetailed(twoCharDisjoint).reason).toBeNull();
    expect(compileSafeRegex(twoCharDisjoint)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(twoCharDisjoint).regex).toBeInstanceOf(RegExp);
    const seventeenWay = "^((a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)x|zx)+$";
    expect(compileSafeRegexDetailed(seventeenWay).reason).toBeNull();
    expect(compileSafeRegexForExec(seventeenWay).regex).toBeInstanceOf(RegExp);
    const overflowingDisjoint = "^((aa|bb|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll|mm|nn|oo|pp|qq)|zz)+$";
    expect(compileSafeRegexDetailed(overflowingDisjoint).reason).toBeNull();
    expect(compileSafeRegex(overflowingDisjoint)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(overflowingDisjoint).regex).toBeInstanceOf(RegExp);
    // Custom redaction compiles the same source with i. ASCII case-folding
    // still leaves these literals unique, so the mask must keep the pattern.
    expect(compileSafeRegexDetailed(overflowingDisjoint, "i").reason).toBeNull();
    expect(compileSafeRegex(overflowingDisjoint, "i")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(overflowingDisjoint, "i").regex).toBeInstanceOf(RegExp);
    const caseCollision = "^((aa|AA|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll|mm|nn|oo|pp|qq)|zz)+$";
    expect(compileSafeRegexDetailed(caseCollision).reason).toBeNull();
    expect(compileSafeRegexDetailed(caseCollision, "i").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(caseCollision, "i")).toBeNull();
    const overflowingCompiled = expectCompiledRegex(overflowingDisjoint);
    expect(overflowingCompiled.test("aazz")).toBe(true);
    expect(overflowingCompiled.test("qqzz")).toBe(true);
    expect(overflowingCompiled.test("az")).toBe(false);
    const classOverflow =
      "^(([a]a|[b]b|[c]c|[d]d|[e]e|[f]f|[g]g|[h]h|[i]i|[j]j|[k]k|[l]l|[m]m|[n]n|[o]o|[p]p|[q]q)|[z]z)+$";
    expect(compileSafeRegexDetailed(classOverflow).reason).toBeNull();
    expect(compileSafeRegex(classOverflow)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(classOverflow).regex).toBeInstanceOf(RegExp);
    expect(compileSafeRegexDetailed(classOverflow, "i").reason).toBeNull();
    expect(compileSafeRegex(classOverflow, "i")).toBeInstanceOf(RegExp);
    const classCompiled = expectCompiledRegex(classOverflow);
    expect(classCompiled.test("aazz")).toBe(true);
    expect(classCompiled.test("az")).toBe(false);
    const classCollision =
      "^(([a]a|[A]A|[c]c|[d]d|[e]e|[f]f|[g]g|[h]h|[i]i|[j]j|[k]k|[l]l|[m]m|[n]n|[o]o|[p]p|[q]q)|[z]z)+$";
    expect(compileSafeRegexDetailed(classCollision).reason).toBeNull();
    expect(compileSafeRegexDetailed(classCollision, "i").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(classCollision, "i")).toBeNull();
  });

  it("accepts truncated equal prefixes whose missing suffixes are disjoint", () => {
    const prefix = `[a]${"a".repeat(31)}`;
    const disjoint = `^(${prefix}b|${prefix}c)+$`;
    expect(compileSafeRegexDetailed(disjoint).reason).toBeNull();
    expect(compileSafeRegex(disjoint)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(disjoint).regex).toBeInstanceOf(RegExp);
    const compiled = expectCompiledRegex(disjoint);
    expect(compiled.test(`${"a".repeat(32)}b${"a".repeat(32)}c`)).toBe(true);
    const longerPrefix = `[a]${"a".repeat(32)}`;
    const longerDisjoint = `^(${longerPrefix}b|${longerPrefix}c)+$`;
    expect(compileSafeRegexDetailed(longerDisjoint).reason).toBeNull();
    expect(compileSafeRegex(longerDisjoint)).toBeInstanceOf(RegExp);
    const longerCompiled = expectCompiledRegex(longerDisjoint);
    expect(longerCompiled.test(`${"a".repeat(33)}b${"a".repeat(33)}c`)).toBe(true);
    expect(compileSafeRegexForExec(longerDisjoint).regex).toBeNull();
    const unit = `[a]${"a".repeat(32)}`;
    expect(compileSafeRegexDetailed(`^(${unit}|${unit}${unit})+$`).reason).toBe(
      "unsafe-nested-repetition",
    );
    const mixedTailUnit = `[a]${"ba".repeat(17)}`;
    const mixedTailOverlapping = `^(${mixedTailUnit}|${mixedTailUnit}${mixedTailUnit})+$`;
    expect(compileSafeRegexDetailed(mixedTailOverlapping).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(mixedTailOverlapping)).toBeNull();
    expect(compileSafeRegexForExec(mixedTailOverlapping).regex).toBeNull();
  });

  it("rejects shared Unicode atoms that the finite probe set never visits", () => {
    const overlapping = "^([Ā]a|ĀaĀa)+$";
    expect(compileSafeRegexDetailed(overlapping).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(overlapping)).toBeNull();
    expect(compileSafeRegexForExec(overlapping).regex).toBeNull();
    const greekLetter = String.raw`^(\p{L}a|\p{Script=Greek}a\p{Script=Greek}a)+$`;
    expect(compileSafeRegexDetailed(greekLetter, "u").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(greekLetter, "u")).toBeNull();
    expect(compileSafeRegexForExec(greekLetter, "u").regex).toBeNull();
    const mixedGreekClass = String.raw`^(\p{L}a|[0\p{Script=Greek}]a[0\p{Script=Greek}]a)+$`;
    expect(compileSafeRegexDetailed(mixedGreekClass, "u").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(mixedGreekClass, "u")).toBeNull();
    expect(compileSafeRegexForExec(mixedGreekClass, "u").regex).toBeNull();
    const disjointMixedDigit = String.raw`^([0\p{Script=Greek}]|[1])+$`;
    expect(compileSafeRegexDetailed(disjointMixedDigit, "u").reason).toBeNull();
    expect(compileSafeRegex(disjointMixedDigit, "u")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexDetailed("^(?:[猫]|[犬])+$").reason).toBeNull();
    expect(compileSafeRegex("^(?:[猫]|[犬])+$")).toBeInstanceOf(RegExp);
  });

  it("rejects dotAll alternatives whose overlap needs the s flag", () => {
    const overlapping = String.raw`^(.a|\na\na)+$`;
    expect(compileSafeRegexDetailed(overlapping, "s").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(overlapping, "s")).toBeNull();
    expect(compileSafeRegexForExec(overlapping, "s").regex).toBeNull();
    expect(compileSafeRegexDetailed(overlapping).reason).toBeNull();
    expect(compileSafeRegex(overlapping)).toBeInstanceOf(RegExp);
  });

  it("accepts disjoint unequal-length alternatives when prefixes do not overlap", () => {
    const grouped = "^(a|[b]c)+$";
    expect(compileSafeRegexDetailed(grouped).reason).toBeNull();
    expect(compileSafeRegex(grouped)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(grouped).regex).toBeInstanceOf(RegExp);
    const compiled = expectCompiledRegex(grouped);
    expect(compiled.test("abc")).toBe(true);
    expect(compiled.test("bca")).toBe(true);
    expect(compileSafeRegexDetailed("^(a|[a]c)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexForExec("^(a|[a]c)+$").regex).toBeNull();
    expect(compileSafeRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
  });

  it("accepts disjoint capturing-group alternatives of equal consumed length", () => {
    const grouped = "^((ab)|(cd))+$";
    const redaction = "corp-((ab)|(cd))+";
    expect(compileSafeRegexDetailed(grouped).reason).toBeNull();
    expect(compileSafeRegex(grouped)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(grouped).regex).toBeInstanceOf(RegExp);
    const compiled = expectCompiledRegex(grouped);
    expect(compiled.test("abcd")).toBe(true);
    expect(compiled.test("cdab")).toBe(true);
    expect(compileSafeRegexDetailed(redaction).reason).toBeNull();
    expect(compileSafeRegex(redaction)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(redaction).regex).toBeInstanceOf(RegExp);
  });

  it("treats decoded scalars as literals during equal-length overlap compare", () => {
    // \x24 is `$`. Re-parsed as regex source, `$` is an end-anchor and the
    // two `$a` languages look disjoint even though both match `$a`.
    const hexDollar = String.raw`^(\x24a|[$]a)+$`;
    expect(compileSafeRegexDetailed(hexDollar).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(hexDollar)).toBeNull();
    expect(compileSafeRegexForExec(hexDollar).regex).toBeNull();
    // `\.` is a literal dot. Re-parsed as regex source, `.` is a wildcard
    // and the disjoint `.a` vs `ba` pair is dropped from redaction.
    const escapedDot = String.raw`corp-(\.a|[b]a)+`;
    expect(compileSafeRegexDetailed(escapedDot).reason).toBeNull();
    expect(compileSafeRegex(escapedDot)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(escapedDot).regex).toBeInstanceOf(RegExp);
    const compiled = expectCompiledRegex(String.raw`^(\.a|[b]a)+$`);
    expect(compiled.test(".aba")).toBe(true);
    expect(compiled.test("ba.a")).toBe(true);
  });

  it("limits octal escapes that start with 4-7 to two digits", () => {
    // JS reads `\400` as `\40` (space) plus literal `0`, same language as ` 0`.
    const overlapping = String.raw`^(\400| 0)+$`;
    const tokens = tokenizePattern(overlapping).filter((token) => token.kind === "simple-token");
    expect(tokens.map((token) => token.source)).toEqual(["^", String.raw`\40`, "0", " ", "0", "$"]);
    expect(compileSafeRegexDetailed(overlapping).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(overlapping)).toBeNull();
    expect(compileSafeRegexForExec(overlapping).regex).toBeNull();
    expect(
      tokenizePattern(String.raw`\141`)
        .filter((token) => token.kind === "simple-token")
        .map((token) => token.source),
    ).toEqual([String.raw`\141`]);
  });

  it("rejects numeric backrefs that the two-digit octal rule would decode as space", () => {
    // 39 empty groups + (a) makes \40 a backref to `a`, so (\40b|abab)+ is (ab|abab)+.
    const twoDigit = `^${"()".repeat(39)}(a)(\\40b|abab)+$`;
    expect(compileSafeRegexDetailed(twoDigit).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(twoDigit)).toBeNull();
    expect(compileSafeRegexForExec(twoDigit).regex).toBeNull();
    // 140 empty groups + (a) makes \141 a backref, not octal `a`.
    const threeDigit = `^${"()".repeat(140)}(a)(\\141b|abab)+$`;
    expect(compileSafeRegexDetailed(threeDigit).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex(threeDigit)).toBeNull();
    expect(compileSafeRegexForExec(threeDigit).regex).toBeNull();
    expect(compileSafeRegexDetailed(String.raw`corp-(\141|BCD)+`).reason).toBeNull();
  });

  it("preserves escaped dollars when stripping alternative anchors", () => {
    const redaction = String.raw`corp-(a\$|b[!])+`;
    const grouped = String.raw`^(a\$|b[!])+$`;
    expect(compileSafeRegexDetailed(redaction).reason).toBeNull();
    expect(compileSafeRegex(redaction)).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec(redaction).regex).toBeInstanceOf(RegExp);
    const compiled = expectCompiledRegex(grouped);
    expect(compiled.test("a$b!")).toBe(true);
    expect(compiled.test("b!a$")).toBe(true);
    expect(compileSafeRegexDetailed(String.raw`^(\$|[$])+$`).reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegexDetailed(String.raw`^(\x24a|[$]a)+$`).reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("treats braced unicode escapes as identity plus quantifier without u/v", () => {
    expect(compileSafeRegexDetailed(String.raw`^(\u{2}|u)+$`).reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegex(String.raw`^(\u{2}|u)+$`)).toBeNull();
    expect(compileSafeRegexForExec(String.raw`^(\u{2}|u)+$`).regex).toBeNull();
    expect(compileSafeRegexDetailed(String.raw`^(\u{2}|u)+$`, "u").reason).toBeNull();
  });

  it("still compiles every default redact pattern after zero-minimum carry", () => {
    const rejected = DEFAULT_REDACT_PATTERNS.flatMap((pattern) => {
      if (typeof pattern !== "string") {
        return [];
      }
      const result = compileSafeRegexDetailed(pattern, "gi");
      return result.reason === null ? [] : [`${result.reason}: ${pattern}`];
    });
    expect(rejected).toEqual([]);
  });

  it("rejects Greek sigma case-fold ReDoS under ignore-case (Σ vs ς)", () => {
    // String#toLowerCase treats these as different; JS /i matches both.
    expect(compileSafeRegexDetailed("^(Σ|ς)+$", "i").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex("^(Σ|ς)+$", "i")).toBeNull();
  });

  it("accepts disjoint escaped ASCII alternatives (decoded scalar escapes)", () => {
    const pattern = String.raw`^(?:\u0061|\u0062)+$`;
    const result = compileSafeRegexDetailed(pattern);
    expect(result.reason).toBeNull();
    expect(result.regex).toBeInstanceOf(RegExp);
  });

  it.each([
    [/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`, true],
    [/discord:tail$/, `${"x".repeat(5000)}discord:tail`, true],
    [/discord:tail$/, `${"x".repeat(5000)}telegram:tail`, false],
  ] as const)("checks bounded regex windows for %s", (pattern, input, expected) => {
    expect(testRegexWithBoundedInput(pattern, input)).toBe(expected);
  });
});
