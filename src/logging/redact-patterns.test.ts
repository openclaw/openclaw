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

  describe("bare pass assignment boundary", () => {
    it("keeps prose where pass: ends a clause but still masks pass as a config key", () => {
      function expectRedaction(input: string, expected = input) {
        expect(redactSensitiveText(input, { mode: "tools" })).toBe(expected);
      }
      const prose =
        "The boundary tests now pass: older clients receive compatible speed values. All checks pass: lint, types.";
      expectRedaction(prose);
      const value = "opaque-pass-secret-1234567890";
      expectRedaction(`smtp.pass: ${value}`, "smtp.pass: opaque…7890");
      expectRedaction(`db-pass: ${value}`, "db-pass: opaque…7890");
      expectRedaction(`pass: "${value}"`, 'pass: "opaque…7890"');
      expectRedaction(`pass = ${value}`, "pass = opaque…7890");
      expectRedaction(`pass= ${value}`, "pass= opaque…7890");
      expectRedaction(`pass: ${value}`, "pass: opaque…7890");
      expectRedaction(
        `smtp:\n  pass: ${value}\n  user: bot`,
        "smtp:\n  pass: opaque…7890\n  user: bot",
      );
      expectRedaction(`{ user: bot, pass: ${value} }`, "{ user: bot, pass: opaque…7890 }");
      expectRedaction(
        `accounts:\n  - pass: ${value}\n  - user: bot`,
        "accounts:\n  - pass: opaque…7890\n  - user: bot",
      );
      expectRedaction(`user=bot; pass: ${value}`, "user=bot; pass: opaque…7890");
      expectRedaction(`user: bot\rpass: ${value}`, "user: bot\rpass: opaque…7890");
      expectRedaction(`user=bot pass: ${value}`, "user=bot pass: opaque…7890");
      expectRedaction(`user = bot pass: ${value}`, "user = bot pass: opaque…7890");
      expectRedaction(`user= bot pass: ${value}`, "user= bot pass: opaque…7890");
      expectRedaction(`user =     bot pass: ${value}`, "user =     bot pass: opaque…7890");
      const longValue = "v".repeat(300);
      expectRedaction(`key=${longValue} pass: ${value}`, `key=${longValue} pass: opaque…7890`);
      expectRedaction(`user\tpass: ${value}`, "user\tpass: opaque…7890");
      expectRedaction(`pass: ${value} pass: ${value}`, "pass: opaque…7890 pass: opaque…7890");
      expectRedaction(
        "pass: opaque-first-value-abcdefghij pass: opaque-second-value-klmnopqrst",
        "pass: opaque…ghij pass: opaque…qrst",
      );
      expectRedaction(
        "smtp.pass: opaque-first-value-abcdefghij pass: opaque-second-value-klmnopqrst",
        "smtp.pass: opaque…ghij pass: opaque…qrst",
      );
      expectRedaction(
        "pass:\n  opaque-first-value-abcdefghij pass: opaque-second-value-klmnopqrst",
        "pass:\n  opaque…ghij pass: opaque…qrst",
      );
      expectRedaction(
        "db_pass: opaque-first-value-abcdefghij pass: opaque-second-value-klmnopqrst",
        "db_pass: opaque…ghij pass: opaque…qrst",
      );
      expectRedaction(`bypass:\n  pass: ${value}`, "bypass:\n  pass: opaque…7890");
      expectRedaction(
        "smtp.pass:\n  opaque-first-value-abcdefghij pass: opaque-second-value-klmnopqrst",
        "smtp.pass:\n  opaque…ghij pass: opaque…qrst",
      );
      expectRedaction(
        "password: opaque-first-value-abcdefghij pass: opaque-second-value-klmnopqrst",
        "password: opaque…ghij pass: opaque…qrst",
      );
      expectRedaction(
        "Authorization: Bearer opaque-bearer-token-value-1234567890 pass: opaque-second-value-klmnopqrst",
        "Authorization: Bearer opaque…7890 pass: opaque…qrst",
      );
      expectRedaction(
        "pass: prefix/pass:embedded\npass: opaque-second-value-klmnopqrst",
        "pass: prefix…dded\npass: opaque…qrst",
      );
      expectRedaction(`? pass\n: ${value}`, "? pass\n: opaque…7890");
      const wordProse = "Use the bypass: it keeps the compass: north.";
      expectRedaction(wordProse);
      expectRedaction(
        `host:db.example.test pass: ${value}`,
        "host:db.example.test pass: opaque…7890",
      );
      expectRedaction(`login (pass: ${value})`, "login (pass: opaque…7890)");
      const moreProse = "Release notes: all suites pass: nothing else changed. Both pass: done.";
      expectRedaction(moreProse);
      expectRedaction(
        `smtp:\n  pass:\n    ${value}\n  user: bot`,
        "smtp:\n  pass:\n    opaque…7890\n  user: bot",
      );
      const wrappedProse = "The boundary tests now pass:\nolder clients receive compatible values.";
      expectRedaction(wrappedProse);
      const summaryProse = "Suite result: 12 pass: 0 fail, 1 skipped.";
      expectRedaction(summaryProse);
    });

    it("keeps mid-sentence pass: prose when it lands on a bounded-replacement chunk start", () => {
      // Inputs above 32 KiB are matched in 16 KiB chunks unless a pattern is registered as
      // chunk-unsafe; a chunk start must not read as a record start for the `^` alternative.
      const clause = "the tests now pass: older clients receive compatible speed values.";
      const prefix = "prose ".repeat(4096).slice(0, 16_384 - "the tests now ".length);
      const text = `${prefix}${clause} ${"more prose ".repeat(2000)}`;
      expect(text.length).toBeGreaterThan(32_768);
      expect(text.indexOf("pass:")).toBe(16_384);
      expect(redactSensitiveText(text, { mode: "tools" })).toBe(text);
    });

    it("stays linear on a long unbroken token before pass:", () => {
      // One forward pass classifies every occurrence, so the cost is linear in the text.
      const token = "a".repeat(200_000);
      const prose = `${token} pass: still prose`;
      expect(redactSensitiveText(prose, { mode: "tools" })).toBe(prose);
      // The `=` after a 200k key run also exercises the default prefilter's obfuscated-key lookbehind
      // on every runtime: JSC abandoned the previous nested form above roughly 70k characters, which
      // skipped default redaction for the whole text on Bun.
      expect(
        redactSensitiveText(`${token}=v pass: opaque-pass-secret-1234567890`, { mode: "tools" }),
      ).toBe(`${token}=v pass: opaque…7890`);
    });
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
