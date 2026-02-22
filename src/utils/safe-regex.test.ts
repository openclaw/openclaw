import { describe, expect, it } from "vitest";
import { isSafeRegexPattern, safePatternMatch } from "./safe-regex.js";

describe("isSafeRegexPattern", () => {
  describe("rejects dangerous patterns", () => {
    it("rejects nested quantifiers (a+)+", () => {
      expect(isSafeRegexPattern("(a+)+")).toBe(false);
    });

    it("rejects nested quantifiers (a*)+", () => {
      expect(isSafeRegexPattern("(a*)+")).toBe(false);
    });

    it("rejects nested quantifiers (a+)*", () => {
      expect(isSafeRegexPattern("(a+)*")).toBe(false);
    });

    it("rejects nested quantifiers (a+)?", () => {
      expect(isSafeRegexPattern("(a+)?")).toBe(false);
    });

    it("rejects complex nested quantifiers (a|b+)+", () => {
      expect(isSafeRegexPattern("(a|b+)+")).toBe(false);
    });

    it("rejects the classic ReDoS pattern (a+)+$", () => {
      expect(isSafeRegexPattern("(a+)+$")).toBe(false);
    });

    it("rejects nested groups ((a+))+", () => {
      expect(isSafeRegexPattern("((a+))+")).toBe(false);
    });

    it("rejects curly-brace quantifiers (a{2,10})+", () => {
      expect(isSafeRegexPattern("(a{2,10})+")).toBe(false);
    });

    it("rejects curly-brace with nested groups ((a{2,})?)*", () => {
      expect(isSafeRegexPattern("((a{2,})?)*")).toBe(false);
    });

    it("rejects triple-nested groups (((a+)))+", () => {
      expect(isSafeRegexPattern("(((a+)))+")).toBe(false);
    });

    it("rejects deeply nested groups ((((a+))))*", () => {
      expect(isSafeRegexPattern("((((a+))))*")).toBe(false);
    });

    it("rejects patterns exceeding 500 characters", () => {
      const longPattern = "a".repeat(501);
      expect(isSafeRegexPattern(longPattern)).toBe(false);
    });
  });

  describe("accepts safe patterns", () => {
    it("accepts simple literal strings", () => {
      expect(isSafeRegexPattern("hello")).toBe(true);
    });

    it("accepts simple character classes", () => {
      expect(isSafeRegexPattern("[a-z]+")).toBe(true);
    });

    it("accepts non-nested quantifiers", () => {
      expect(isSafeRegexPattern("a+b*c?")).toBe(true);
    });

    it("accepts groups without nested quantifiers", () => {
      expect(isSafeRegexPattern("(abc)+")).toBe(true);
    });

    it("accepts alternation without quantifiers", () => {
      expect(isSafeRegexPattern("(foo|bar)")).toBe(true);
    });

    it("accepts common session key patterns", () => {
      expect(isSafeRegexPattern("^session-.*")).toBe(true);
      expect(isSafeRegexPattern("user-\\d+")).toBe(true);
    });
  });
});

describe("safePatternMatch", () => {
  it("matches literal substrings", () => {
    expect(safePatternMatch("hello world", "world")).toBe(true);
  });

  it("returns false for non-matching literals", () => {
    expect(safePatternMatch("hello world", "foo")).toBe(false);
  });

  it("matches safe regex patterns", () => {
    expect(safePatternMatch("session-123", "^session-\\d+$")).toBe(true);
  });

  it("rejects dangerous patterns and returns false", () => {
    const warnings: string[] = [];
    const logger = { warn: (msg: string) => warnings.push(msg) };

    // This pattern would hang if executed
    const result = safePatternMatch("aaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "(a+)+$", logger);

    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dangerous regex pattern");
  });

  it("handles invalid regex gracefully", () => {
    // Invalid regex syntax - unclosed group
    expect(safePatternMatch("test", "(unclosed")).toBe(false);
  });

  it("prefers literal match over regex for performance", () => {
    // The literal ".*" is found in the string, so regex isn't needed
    expect(safePatternMatch("match .* this", ".*")).toBe(true);
  });

  it("rejects regex matching on very long inputs (defense-in-depth)", () => {
    const warnings: string[] = [];
    const logger = { warn: (msg: string) => warnings.push(msg) };

    // Input over 1000 chars should fall back to literal match only
    const longInput = "a".repeat(1001);
    const result = safePatternMatch(longInput, "^a+$", logger);

    expect(result).toBe(false); // Literal "^a+$" not found, regex skipped
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exceeds safe length");
  });

  it("allows regex on inputs under the length limit", () => {
    const input = "a".repeat(500);
    expect(safePatternMatch(input, "^a+$")).toBe(true);
  });
});
