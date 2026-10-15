// @vitest-environment node
// Control UI tests cover text direction behavior.
import { describe, expect, it } from "vitest";
import { detectTextDirection } from "./text-direction.ts";

// Bidi controls are invisible, so every case names the character it exercises.
const CASES: [name: string, text: string | null, expected: "rtl" | "ltr"][] = [
  ["null", null, "ltr"],
  ["empty string", "", "ltr"],
  ["hebrew", "\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD", "rtl"],
  ["arabic", "\u0645\u0631\u062D\u0628\u0627", "rtl"],
  ["latin", "Hello world", "ltr"],
  ["markdown emphasis before hebrew", "**\u05E9\u05DC\u05D5\u05DD", "rtl"],
  ["markdown heading before arabic", "# \u0645\u0631\u062D\u0628\u0627", "rtl"],
  ["markdown list before latin", "- hello", "ltr"],
  ["RLM overriding latin", "\u200FHello", "rtl"],
  ["RLO overriding latin", "\u202EHello", "rtl"],
  ["RLI and PDI around hebrew", "\u2067\u05E9\u05DC\u05D5\u05DD\u2069", "rtl"],
  ["FSI and PDI around hebrew", "\u2068\u05E9\u05DC\u05D5\u05DD\u2069", "rtl"],
  ["BOM before latin", "\uFEFFHello", "ltr"],
  ["format characters only", "\uFEFF\u200D", "ltr"],
  ["ARABIC NUMBER SIGN before arabic-indic digit", "\u0600\u0663", "rtl"],
  // No strong character anywhere: an Arabic number sign and an ASCII digit are both weak types,
  // so first-strong finds nothing and the ltr default stands. Pinned so a future skip-class
  // change has to be deliberate about it.
  ["ARABIC NUMBER SIGN before ascii digit", "\u06003", "ltr"],
];

describe("detectTextDirection", () => {
  it.each(CASES)("resolves %s", (_name, text, expected) => {
    expect(detectTextDirection(text)).toBe(expected);
  });

  // Enumerated cases can only pin the characters someone thought of. This sweeps the whole
  // Cf family so a skip class that silently stops covering part of it fails here.
  it("steps over every direction-neutral format character to reach the strong letter", () => {
    const HEBREW_LETTER = "\u05E9";
    const EXPLICIT_LTR = new Set(["\u200E", "\u202A", "\u202D", "\u2066"]);
    const offenders: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        continue;
      }
      const char = String.fromCodePoint(codePoint);
      if (!/\p{Cf}/u.test(char)) {
        continue;
      }
      // A leading left-to-right override is meant to win; everything else must fall through.
      const expected = EXPLICIT_LTR.has(char) ? "ltr" : "rtl";
      const actual = detectTextDirection(char + HEBREW_LETTER);
      if (actual !== expected) {
        offenders.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} -> ${actual}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
