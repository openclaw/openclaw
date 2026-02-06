/**
 * Pattern Matcher Tests
 */

import { describe, it, expect } from "vitest";
import { PatternMatcher, PatternUtils } from "../pattern-matcher.js";
import type { NoisePattern } from "../types.js";

describe("PatternMatcher", () => {
  describe("prefix matching", () => {
    it("should match lines starting with prefix", () => {
      const patterns: NoisePattern[] = [
        { type: "prefix", value: "●" },
        { type: "prefix", value: "⏵⏵" },
      ];
      const matcher = new PatternMatcher(patterns);

      expect(matcher.matchesAny("● How did that go?")).toBe(true);
      expect(matcher.matchesAny("  ● How did that go?")).toBe(true);
      expect(matcher.matchesAny("⏵⏵ bypass permissions on")).toBe(true);
      expect(matcher.matchesAny("This is normal text")).toBe(false);
    });

    it("should trim leading whitespace before matching", () => {
      const pattern: NoisePattern = { type: "prefix", value: "●" };
      const matcher = new PatternMatcher([pattern]);

      expect(matcher.matchesAny("   ● Indented feedback")).toBe(true);
      expect(matcher.matchesAny("\t● Tabbed feedback")).toBe(true);
    });
  });

  describe("regex matching", () => {
    it("should match lines against regex patterns", () => {
      const patterns: NoisePattern[] = [
        { type: "regex", pattern: "ctrl\\+[a-z]" },
        { type: "regex", pattern: "\\d+% context left" },
      ];
      const matcher = new PatternMatcher(patterns);

      expect(matcher.matchesAny("Press ctrl+o for history")).toBe(true);
      expect(matcher.matchesAny("94% context left")).toBe(true);
      expect(matcher.matchesAny("15% context left")).toBe(true);
      expect(matcher.matchesAny("Normal text")).toBe(false);
    });

    it("should handle invalid regex patterns gracefully", () => {
      const patterns: NoisePattern[] = [{ type: "regex", pattern: "[invalid(" }];

      // Should not throw during construction
      expect(() => new PatternMatcher(patterns)).not.toThrow();
    });
  });

  describe("separator matching", () => {
    it("should match separator lines", () => {
      const pattern: NoisePattern = { type: "separator", chars: "─═" };
      const matcher = new PatternMatcher([pattern]);

      expect(matcher.matchesAny("───────────────────")).toBe(true);
      expect(matcher.matchesAny("═══════════════════")).toBe(true);
      expect(matcher.matchesAny("  ───────────────  ")).toBe(true);
      expect(matcher.matchesAny("─")).toBe(false); // Too short
      expect(matcher.matchesAny("──")).toBe(false); // Too short
      expect(matcher.matchesAny("Normal text")).toBe(false);
    });

    it("should use default separator chars if none provided", () => {
      const pattern: NoisePattern = { type: "separator" };
      const matcher = new PatternMatcher([pattern]);

      expect(matcher.matchesAny("───────────────────")).toBe(true);
      expect(matcher.matchesAny("═══════════════════")).toBe(true);
      expect(matcher.matchesAny("-------------------")).toBe(true);
      expect(matcher.matchesAny("___________________")).toBe(true);
    });
  });

  describe("context_hint matching", () => {
    it("should match context hints like regex", () => {
      const pattern: NoisePattern = { type: "context_hint", pattern: "\\? for shortcuts" };
      const matcher = new PatternMatcher([pattern]);

      expect(matcher.matchesAny("? for shortcuts")).toBe(true);
      expect(matcher.matchesAny("  ? for shortcuts  ")).toBe(true);
    });
  });

  describe("matchesAny", () => {
    it("should return true if any pattern matches", () => {
      const patterns: NoisePattern[] = [
        { type: "prefix", value: "●" },
        { type: "regex", pattern: "ctrl\\+[a-z]" },
        { type: "separator" },
      ];
      const matcher = new PatternMatcher(patterns);

      expect(matcher.matchesAny("● Feedback")).toBe(true);
      expect(matcher.matchesAny("Press ctrl+o")).toBe(true);
      expect(matcher.matchesAny("───────────────")).toBe(true);
      expect(matcher.matchesAny("Normal text")).toBe(false);
    });
  });
});

describe("PatternUtils", () => {
  describe("isSeparatorLine", () => {
    it("should identify separator lines", () => {
      expect(PatternUtils.isSeparatorLine("───────────────")).toBe(true);
      expect(PatternUtils.isSeparatorLine("═══════════════")).toBe(true);
      expect(PatternUtils.isSeparatorLine("---------------")).toBe(true);
      expect(PatternUtils.isSeparatorLine("_______________")).toBe(true);
    });

    it("should trim whitespace when checking", () => {
      expect(PatternUtils.isSeparatorLine("  ───────────  ")).toBe(true);
      expect(PatternUtils.isSeparatorLine("\t═══════════\t")).toBe(true);
    });

    it("should require minimum length", () => {
      expect(PatternUtils.isSeparatorLine("─")).toBe(false);
      expect(PatternUtils.isSeparatorLine("──")).toBe(false);
      expect(PatternUtils.isSeparatorLine("───")).toBe(true);
    });

    it("should not match mixed characters", () => {
      expect(PatternUtils.isSeparatorLine("───===───")).toBe(false);
      expect(PatternUtils.isSeparatorLine("─── text ───")).toBe(false);
    });

    it("should accept custom separator chars", () => {
      expect(PatternUtils.isSeparatorLine("───────", "─")).toBe(true);
      expect(PatternUtils.isSeparatorLine("═══════", "─")).toBe(false);
    });
  });

  describe("stripMarkerAndEcho", () => {
    it("should strip response marker", () => {
      const result = PatternUtils.stripMarkerAndEcho("⏺ This is a response", "⏺");
      expect(result).toBe("This is a response");
    });

    it("should strip marker and echo pattern", () => {
      const result = PatternUtils.stripMarkerAndEcho(
        "⏺ HEALTH_1770407657040",
        "⏺",
        "^HEALTH_\\d+$",
      );
      expect(result).toBe("");
    });

    it("should handle marker with leading whitespace", () => {
      const result = PatternUtils.stripMarkerAndEcho("  ⏺ Response text", "⏺");
      expect(result).toBe("Response text");
    });

    it("should handle invalid echo pattern gracefully", () => {
      const result = PatternUtils.stripMarkerAndEcho("⏺ HEALTH_123", "⏺", "[invalid(");
      // Should return without echo removal
      expect(result).toBe("HEALTH_123");
    });

    it("should strip marker and echo on single line", () => {
      const result = PatternUtils.stripMarkerAndEcho("⏺ HEALTH_1770407657040", "⏺", "HEALTH_\\d+");
      // Should remove marker and health check echo
      expect(result).toBe("");
    });
  });

  describe("startsWithAny", () => {
    it("should check if line starts with any prefix", () => {
      const prefixes = ["●", "⏵⏵", "⎿"];

      expect(PatternUtils.startsWithAny("● Feedback", prefixes)).toBe(true);
      expect(PatternUtils.startsWithAny("⏵⏵ Status", prefixes)).toBe(true);
      expect(PatternUtils.startsWithAny("⎿ File", prefixes)).toBe(true);
      expect(PatternUtils.startsWithAny("Normal text", prefixes)).toBe(false);
    });

    it("should trim leading whitespace", () => {
      const prefixes = ["●"];

      expect(PatternUtils.startsWithAny("  ● Indented", prefixes)).toBe(true);
      expect(PatternUtils.startsWithAny("\t● Tabbed", prefixes)).toBe(true);
    });
  });
});
