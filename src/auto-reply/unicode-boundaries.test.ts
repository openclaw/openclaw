import { describe, expect, it } from "vitest";
import { wrapWordBoundary, UNICODE_WORD_START, UNICODE_WORD_END, UNICODE_NON_WORD } from "./unicode-boundaries.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Unicode word boundaries", () => {
  describe("wrapWordBoundary", () => {
    it("matches ASCII name in ASCII context", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("Puck")), "iu");
      expect(re.test("Hej Puck!")).toBe(true);
      expect(re.test("Puck")).toBe(true);
      expect(re.test("@Puck hello")).toBe(true);
    });

    it("does not match partial ASCII words", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("Puck")), "iu");
      expect(re.test("Pucky")).toBe(false);
      expect(re.test("unpuck")).toBe(false);
    });

    it("matches Swedish name with åäö", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("Björk")), "iu");
      expect(re.test("Hej Björk!")).toBe(true);
      expect(re.test("Björk sa hej")).toBe(true);
      expect(re.test("sa Björk")).toBe(true);
    });

    it("does not match partial Swedish words", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("Björk")), "iu");
      expect(re.test("Björken")).toBe(false);
    });

    it("matches German name with ü", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("Pück")), "iu");
      expect(re.test("Hej Pück!")).toBe(true);
    });

    it("matches French name with accents", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("François")), "iu");
      expect(re.test("Bonjour François!")).toBe(true);
      expect(re.test("François est là")).toBe(true);
    });

    it("matches Spanish name with ñ", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("José")), "iu");
      expect(re.test("Hola José!")).toBe(true);
    });

    it("treats café as one word", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("café")), "iu");
      expect(re.test("I love café!")).toBe(true);
      expect(re.test("caféine")).toBe(false);
    });

    it("treats über as one word", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("über")), "iu");
      expect(re.test("Das ist über cool")).toBe(true);
      expect(re.test("überall")).toBe(false);
    });

    it("works with CJK characters", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("太郎")), "iu");
      expect(re.test("こんにちは 太郎 さん")).toBe(true);
    });

    it("matches at string boundaries", () => {
      const re = new RegExp(wrapWordBoundary(escapeRegExp("Ärlig")), "iu");
      expect(re.test("Ärlig")).toBe(true);
      expect(re.test("Ärlig!")).toBe(true);
      expect(re.test("!Ärlig")).toBe(true);
    });
  });

  describe("UNICODE_NON_WORD", () => {
    it("matches spaces and punctuation", () => {
      const re = new RegExp(UNICODE_NON_WORD, "u");
      expect(re.test(" ")).toBe(true);
      expect(re.test("!")).toBe(true);
      expect(re.test(".")).toBe(true);
    });

    it("does not match letters or digits", () => {
      const re = new RegExp(UNICODE_NON_WORD, "u");
      expect(re.test("a")).toBe(false);
      expect(re.test("å")).toBe(false);
      expect(re.test("é")).toBe(false);
      expect(re.test("9")).toBe(false);
      expect(re.test("_")).toBe(false);
    });
  });

  describe("regression: \\b fails with non-ASCII (before fix)", () => {
    it("ASCII \\b breaks Swedish word boundary", () => {
      // This demonstrates the problem: \b treats ö as non-word
      const broken = /\bBjörk\b/i;
      // \b sees the ö→k transition as already a boundary, so "Björken" matches!
      // This is the bug we're fixing.
      expect(broken.test("Björken")).toBe(true); // BUG: should be false

      // Our fix:
      const fixed = new RegExp(wrapWordBoundary(escapeRegExp("Björk")), "iu");
      expect(fixed.test("Björken")).toBe(false); // CORRECT
    });
  });
});
