import { describe, expect, it } from "vitest";
import { compileConfigRegex } from "../security/config-regex.js";
import { parseRedactPatternSource } from "./redact-pattern-runtime.js";
import { AWS_SECRET_ACCESS_KEY_MATCHER, DEFAULT_REDACT_PATTERNS } from "./redact-patterns.js";
import { redactSensitiveFieldValue, redactSensitiveText, resolveRedactOptions } from "./redact.js";

describe("default pattern table", () => {
  it.each(["--token", "--password", "--api-key", "--security-code"])(
    "masks a standalone spaced %s argument without another field delimiter",
    (flag) => {
      const input = `${flag} fixtureValue1234567890`;
      const expected = `${flag} fixtur…7890`;
      expect(redactSensitiveText(input, { mode: "tools" })).toBe(expected);
      expect(redactSensitiveFieldValue("content", input, { mode: "tools" })).toBe(expected);
    },
  );
  // A default pattern the safe-regex guard rejects is dropped silently at runtime, which disables
  // that whole redaction family; fail here with the offending source instead.
  it("compiles every default string pattern under the safe-regex guard", () => {
    for (const raw of DEFAULT_REDACT_PATTERNS) {
      if (typeof raw !== "string") {
        continue;
      }
      const compiled = compileConfigRegex(...parseRedactPatternSource(raw));
      expect(compiled?.regex, raw).not.toBeNull();
    }
  });

  it("distinguishes bare pass assignments from prose across record and chunk boundaries", () => {
    const value = "opaque-pass-secret-1234567890";
    const token = "a".repeat(200_000);
    // A chunk start must not turn mid-sentence prose into a record start.
    const prefix = "prose ".repeat(4096).slice(0, 16_384 - "the tests now ".length);
    const chunked = `${prefix}the tests now pass: older clients receive compatible speed values. ${"more prose ".repeat(2000)}`;
    expect(chunked.length).toBeGreaterThan(32_768);
    expect(chunked.indexOf("pass:")).toBe(16_384);
    for (const input of [
      "The boundary tests now pass: older clients receive compatible speed values. All checks pass: lint, types.",
      "Use the bypass: it keeps the compass: north.",
      "Release notes: all suites pass: nothing else changed. Both pass: done.",
      "The boundary tests now pass:\nolder clients receive compatible values.",
      "Suite result: 12 pass: 0 fail, 1 skipped.",
      chunked,
      `${token} pass: still prose`,
    ]) {
      expect(redactSensitiveText(input, { mode: "tools" })).toBe(input);
    }
    const assignments: [string, string][] = [
      ["smtp.pass: ", ""],
      ["db-pass: ", ""],
      ['pass: "', '"'],
      ["pass = ", ""],
      ["pass= ", ""],
      ["pass: ", ""],
      ["smtp:\n  pass: ", "\n  user: bot"],
      ["{ user: bot, pass: ", " }"],
      ["accounts:\n  - pass: ", "\n  - user: bot"],
      ["user=bot; pass: ", ""],
      ["user: bot\rpass: ", ""],
      ["user=bot pass: ", ""],
      ["user = bot pass: ", ""],
      ["user= bot pass: ", ""],
      ["user =     bot pass: ", ""],
      [`key=${"v".repeat(300)} pass: `, ""],
      ["user\tpass: ", ""],
      ["bypass:\n  pass: ", ""],
      ["? pass\n: ", ""],
      ["host:db.example.test pass: ", ""],
      ["login (pass: ", ")"],
      ["smtp:\n  pass:\n    ", "\n  user: bot"],
      // JSC abandoned the old nested prefilter lookbehind on key runs above roughly 70k.
      [`${token}=v pass: `, ""],
    ];
    const cases: [string, string][] = assignments.map(([start, end]) => [
      `${start}${value}${end}`,
      `${start}opaque…7890${end}`,
    ]);
    for (const start of [
      "pass: ",
      "smtp.pass: ",
      "pass:\n  ",
      "db_pass: ",
      "smtp.pass:\n  ",
      "password: ",
    ]) {
      cases.push([
        `${start}opaque-first-value-abcdefghij pass: opaque-second-value-klmnopqrst`,
        `${start}opaque…ghij pass: opaque…qrst`,
      ]);
    }
    cases.push(
      [`pass: ${value} pass: ${value}`, "pass: opaque…7890 pass: opaque…7890"],
      [
        "Authorization: Bearer opaque-bearer-token-value-1234567890 pass: opaque-second-value-klmnopqrst",
        "Authorization: Bearer opaque…7890 pass: opaque…qrst",
      ],
      [
        "pass: prefix/pass:embedded\npass: opaque-second-value-klmnopqrst",
        "pass: prefix…dded\npass: opaque…qrst",
      ],
    );
    for (const [input, expected] of cases) {
      expect(redactSensitiveText(input, { mode: "tools" }), input).toBe(expected);
    }
  });
});

describe("AWS candidate prefilter", () => {
  it("agrees with the original value rule on seeded credential and noncredential text", () => {
    // Freeze the pre-optimization predicate as the differential oracle.
    const original =
      /(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])(?=[A-Za-z0-9/+=]{0,39}[0-9/+=])(?=[A-Za-z0-9/+=]{0,39}[G-Zg-z/+=])[A-Za-z0-9/+=]{40}/u;
    let seed = 0x5eed;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % max;
    };
    const alphabets = [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+=",
      "0123456789abcdefABCDEF",
      "abcdefghijklmnopqrstuvwxyz0123456789",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      "Aa/+=",
    ];
    const separators = " _-:@\n\0ſK🦞\ud800";
    for (const alphabet of alphabets) {
      for (const length of [0, 2, 18, 39, 40, 41, 80, 200]) {
        for (let sample = 0; sample < 125; sample++) {
          const run = Array.from({ length }, () => alphabet.charAt(random(alphabet.length))).join(
            "",
          );
          const split = random(run.length + 1);
          const separator = separators.charAt(random(separators.length + 1));
          const text = `${run.slice(0, split)}${separator}${run.slice(split)}`;
          expect(AWS_SECRET_ACCESS_KEY_MATCHER.couldMatch(text), text).toBe(original.test(text));
        }
      }
    }
  });
});

describe("base64-safe vendor token patterns", () => {
  it("keeps a large plus-joined run linear through the data-URL guard", () => {
    // Every `+` is a token boundary; the spliced key only trips the obfuscated-key prefilter.
    const input = `${"a+".repeat(50_000)}pass\u200Bword=opaque-value-1234567890`;
    const started = performance.now();
    expect(redactSensitiveText(input, { mode: "tools" })).toBe(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("owner-boundary counterexamples", () => {
  it("keeps configured vendor regexes on their own path so data-URL content stays masked", () => {
    // A configured expression that is not one of the exact guarded built-in sources must keep
    // its original regex path: the data-URL exemption belongs to the guarded scanner, not to
    // every expression that happens to match the same shape.
    const configured = /(^|[^A-Za-z0-9])(AKIA[A-Z0-9]{16})/g;
    const dataUrl = `data:text/plain;base64,AKIA${"A".repeat(16)}`;
    const output = redactSensitiveText(dataUrl, { mode: "tools", patterns: [configured] });
    expect(output).not.toBe(dataUrl);
    // The guarded built-in scanner keeps its data-URL exemption on the exact guarded source.
    const guarded = redactSensitiveText(dataUrl, { mode: "tools" });
    expect(guarded).toBe(dataUrl);
  });

  it("masks a built-in token crossing the former chunk boundary under combined policies", () => {
    // A custom logging.redactPatterns entry composes with the default arrays; the default
    // glpat- rule keeps whole-text scanning, so a value straddling offset 16,384 still masks.
    const prefix = "x".repeat(16_380);
    const text = `${prefix} glpat-${"a".repeat(24)}`;
    const output = redactSensitiveText(text, {
      mode: "tools",
      patterns: [...DEFAULT_REDACT_PATTERNS, /unrelated-config-key-[a-z]+/g],
    });
    // The mask keeps the glpat- prefix as a hint; the secret value itself must not survive.
    expect(output).not.toContain("a".repeat(24));
  });
});

describe("repeat rewrite atom boundaries", () => {
  it("leaves non-unicode astral quantifiers unchanged so their language is preserved", () => {
    // Without the u flag JavaScript quantifies only the trailing code unit of a literal
    // astral character; rewriting it as a whole-code-point atom changes the language.
    // Routed through the production boundary so the assertion covers the real rewriter.
    const configured = "^(😀{1,})$";
    const options = resolveRedactOptions({
      mode: "tools",
      patterns: [configured],
    });
    // Without the u flag JavaScript quantifies only the trailing code unit of a literal
    // astral character. The configured string is resolved through parsePattern (the real
    // rewriter), and the resolved pattern must still match the legacy-language input.
    const resolved = options.patterns[0];
    expect(resolved).toBeDefined();
    expect(resolved instanceof RegExp).toBe(true);
    expect((resolved as RegExp).test("😀")).toBe(true);
  });
});

describe("configured source language preservation", () => {
  it.each([
    ["property identity escape", "^\\p{L}{1,}$"],
    ["named backreference without captures", "^\\k<word>{1,}$"],
    ["control escape", "^\\c1{1,}$"],
    ["octal numeric escape", "^\\1234{1,}$"],
    ["incomplete unicode escape", "^\\u12{1,}$"],
  ])("preserves the legacy language of %s", (_name, configured) => {
    // Operator-configured sources compile unmodified: the rewriter optimizes only canonical
    // built-in sources, so the resolved pattern keeps the exact configured source string.
    const resolved = resolveRedactOptions({ mode: "tools", patterns: [configured] });
    const pattern = resolved.patterns[0];
    expect(pattern instanceof RegExp).toBe(true);
    expect((pattern as RegExp).source).toBe(configured);
  });

  it("preserves verified legacy matching semantics for escape-shaped sources", () => {
    // Split from the source-equality cases above so each assertion is unconditional.
    const matching: Array<[string, string]> = [
      ["^\\p{L}{1,}$", "p{L}}"],
      ["^\\k<word>{1,}$", "k<word>"],
      ["^\\1234{1,}$", "S44"],
      ["^\\u12{1,}$", "u122"],
    ];
    for (const [configured, input] of matching) {
      const resolved = resolveRedactOptions({ mode: "tools", patterns: [configured] });
      const pattern = resolved.patterns[0] as RegExp;
      expect(pattern.test(input)).toBe(true);
    }
  });
});
