import { describe, expect, it } from "vitest";
import { displayWidth, splitGraphemes } from "./display-width.js";

describe("shared/text/display-width", () => {
  it("measures ASCII, CJK, and combining marks", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("表")).toBe(2);
    expect(displayWidth("e\u0301")).toBe(1);
  });

  it("treats emoji grapheme clusters as terminal-width units", () => {
    expect(splitGraphemes("👨‍👩‍👧‍👦")).toEqual(["👨‍👩‍👧‍👦"]);
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(displayWidth("🇺🇸")).toBe(2);
    expect(displayWidth("✈️")).toBe(2);
  });

  it("keeps text-presentation symbols narrow without emoji selectors", () => {
    expect(displayWidth("©")).toBe(1);
    expect(displayWidth("™")).toBe(1);
    expect(displayWidth("❤")).toBe(1);
    expect(displayWidth("✈")).toBe(1);
  });
});
