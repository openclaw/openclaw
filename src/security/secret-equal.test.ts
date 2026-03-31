import { describe, expect, it } from "vitest";
import { safeEqualSecret } from "./secret-equal.js";

describe("safeEqualSecret", () => {
  describe("matching strings", () => {
    it("returns true for identical ASCII strings", () => {
      expect(safeEqualSecret("secret-token", "secret-token")).toBe(true);
    });

    it("returns true for long identical strings", () => {
      const long = "a".repeat(10_000);
      expect(safeEqualSecret(long, long)).toBe(true);
    });

    it("returns true for strings with special characters", () => {
      const special = "p@$$w0rd!#%^&*()_+-=[]{}|;':\",./<>?";
      expect(safeEqualSecret(special, special)).toBe(true);
    });
  });

  describe("differing strings", () => {
    it("returns false when strings differ by one character", () => {
      expect(safeEqualSecret("secret-token", "secret-tokEn")).toBe(false);
    });

    it("returns false for completely different strings", () => {
      expect(safeEqualSecret("alpha", "bravo")).toBe(false);
    });

    it("returns false when one string is a prefix of the other", () => {
      expect(safeEqualSecret("secret", "secret-token")).toBe(false);
    });

    it("returns false for case-sensitive mismatch", () => {
      expect(safeEqualSecret("Secret", "secret")).toBe(false);
    });
  });

  describe("different length strings", () => {
    it("returns false for short vs long strings", () => {
      expect(safeEqualSecret("short", "much-longer-string")).toBe(false);
    });

    it("returns false for empty vs non-empty strings", () => {
      expect(safeEqualSecret("", "non-empty")).toBe(false);
    });

    it("returns false for single char vs multi-char", () => {
      expect(safeEqualSecret("a", "ab")).toBe(false);
    });
  });

  describe("empty strings", () => {
    it("returns true when both strings are empty", () => {
      expect(safeEqualSecret("", "")).toBe(true);
    });
  });

  describe("unicode strings", () => {
    it("returns true for matching unicode strings", () => {
      expect(safeEqualSecret("hello-\u{1F600}-world", "hello-\u{1F600}-world")).toBe(true);
    });

    it("returns false for differing unicode strings", () => {
      expect(safeEqualSecret("hello-\u{1F600}", "hello-\u{1F601}")).toBe(false);
    });

    it("handles multi-byte characters correctly", () => {
      const cjk = "\u4F60\u597D\u4E16\u754C"; // Chinese characters
      expect(safeEqualSecret(cjk, cjk)).toBe(true);
      expect(safeEqualSecret(cjk, "\u4F60\u597D")).toBe(false);
    });
  });

  describe("null and undefined inputs", () => {
    it("returns false when first argument is undefined", () => {
      expect(safeEqualSecret(undefined, "secret")).toBe(false);
    });

    it("returns false when second argument is undefined", () => {
      expect(safeEqualSecret("secret", undefined)).toBe(false);
    });

    it("returns false when both arguments are undefined", () => {
      expect(safeEqualSecret(undefined, undefined)).toBe(false);
    });

    it("returns false when first argument is null", () => {
      expect(safeEqualSecret(null, "secret")).toBe(false);
    });

    it("returns false when second argument is null", () => {
      expect(safeEqualSecret("secret", null)).toBe(false);
    });

    it("returns false when both arguments are null", () => {
      expect(safeEqualSecret(null, null)).toBe(false);
    });

    it("returns false for null vs undefined", () => {
      expect(safeEqualSecret(null, undefined)).toBe(false);
    });
  });

  describe("timing resistance", () => {
    it("takes similar time for matching and non-matching strings of equal length", () => {
      const a = "x".repeat(1000);
      const b = "y".repeat(1000);
      const iterations = 1000;

      // Warm up to stabilize JIT
      for (let i = 0; i < 100; i++) {
        safeEqualSecret(a, a);
        safeEqualSecret(a, b);
      }

      const startMatch = performance.now();
      for (let i = 0; i < iterations; i++) {
        safeEqualSecret(a, a);
      }
      const matchTime = performance.now() - startMatch;

      const startDiffer = performance.now();
      for (let i = 0; i < iterations; i++) {
        safeEqualSecret(a, b);
      }
      const differTime = performance.now() - startDiffer;

      // The ratio of match time to differ time should be close to 1.
      // Allow a generous 5x tolerance to avoid flaky tests while still
      // catching naive early-return implementations.
      const ratio = matchTime / differTime;
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(5);
    });
  });
});
