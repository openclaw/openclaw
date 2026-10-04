import { describe, expect, it } from "vitest";
import { compileConfigRegex } from "../security/config-regex.js";
import { parseRedactPatternSource } from "./redact-pattern-runtime.js";
import { AWS_SECRET_ACCESS_KEY_MATCHER, DEFAULT_REDACT_PATTERNS } from "./redact-patterns.js";
import { redactSensitiveText } from "./redact.js";

describe("default pattern table", () => {
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
