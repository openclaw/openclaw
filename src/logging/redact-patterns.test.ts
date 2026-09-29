import { describe, expect, it } from "vitest";
import { compileConfigRegex } from "../security/config-regex.js";
import { parseRedactPatternSource } from "./redact-pattern-runtime.js";
import {
  AWS_SECRET_ACCESS_KEY_MATCHER,
  DEFAULT_REDACT_STRING_PATTERNS,
} from "./redact-patterns.js";
import { redactSensitiveText } from "./redact.js";

describe("default pattern table", () => {
  // A default pattern the safe-regex guard rejects is dropped silently at runtime, which disables
  // that whole redaction family; fail here with the offending source instead.
  it("compiles every default string pattern under the safe-regex guard", () => {
    for (const raw of DEFAULT_REDACT_STRING_PATTERNS) {
      const compiled = compileConfigRegex(...parseRedactPatternSource(raw));
      expect(compiled?.regex, raw).not.toBeNull();
    }
  });

  describe("bare pass assignment boundary", () => {
    it("keeps prose where pass: ends a clause but still masks pass as a config key", () => {
      const prose =
        "The boundary tests now pass: older clients receive compatible speed values. All checks pass: lint, types.";
      expect(redactSensitiveText(prose, { mode: "tools" })).toBe(prose);
      const value = "opaque-pass-secret-1234567890";
      expect(redactSensitiveText(`smtp.pass: ${value}`, { mode: "tools" })).toBe(
        "smtp.pass: opaque…7890",
      );
      expect(redactSensitiveText(`db-pass: ${value}`, { mode: "tools" })).toBe(
        "db-pass: opaque…7890",
      );
      expect(redactSensitiveText(`pass: "${value}"`, { mode: "tools" })).toBe(
        'pass: "opaque…7890"',
      );
      expect(redactSensitiveText(`pass = ${value}`, { mode: "tools" })).toBe("pass = opaque…7890");
      expect(redactSensitiveText(`pass= ${value}`, { mode: "tools" })).toBe("pass= opaque…7890");
      expect(redactSensitiveText(`pass: ${value}`, { mode: "tools" })).toBe("pass: opaque…7890");
      expect(redactSensitiveText(`smtp:\n  pass: ${value}\n  user: bot`, { mode: "tools" })).toBe(
        "smtp:\n  pass: opaque…7890\n  user: bot",
      );
      expect(redactSensitiveText(`{ user: bot, pass: ${value} }`, { mode: "tools" })).toBe(
        "{ user: bot, pass: opaque…7890 }",
      );
      expect(
        redactSensitiveText(`accounts:\n  - pass: ${value}\n  - user: bot`, { mode: "tools" }),
      ).toBe("accounts:\n  - pass: opaque…7890\n  - user: bot");
      expect(redactSensitiveText(`user=bot; pass: ${value}`, { mode: "tools" })).toBe(
        "user=bot; pass: opaque…7890",
      );
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
