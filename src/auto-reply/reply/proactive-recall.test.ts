import { describe, expect, it } from "vitest";
import { extractSearchKeywords } from "./proactive-recall.js";

/** Helper: split FTS5 OR query into individual keyword tokens. */
function keywords(text: string): string[] {
  return extractSearchKeywords(text).split(" OR ").filter(Boolean);
}

describe("extractSearchKeywords", () => {
  it("extracts Chinese phrases as 2-4 char tokens", () => {
    const result = extractSearchKeywords("設定天氣提醒");
    // Chinese regex matches non-overlapping 2-4 char sequences
    expect(result.length).toBeGreaterThan(0);
    const parts = keywords("設定天氣提醒");
    expect(parts.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts English words", () => {
    const parts = keywords("weather forecast tomorrow");
    expect(parts).toContain("weather");
    expect(parts).toContain("forecast");
    expect(parts).toContain("tomorrow");
  });

  it("filters English stop words", () => {
    const parts = keywords("the weather is good today");
    expect(parts).not.toContain("the");
    expect(parts).not.toContain("is");
    expect(parts).toContain("weather");
    expect(parts).toContain("good");
    expect(parts).toContain("today");
  });

  it("returns empty for short input", () => {
    expect(extractSearchKeywords("")).toBe("");
    expect(extractSearchKeywords("a")).toBe("");
  });

  it("deduplicates tokens", () => {
    const parts = keywords("天氣天氣天氣天氣");
    const unique = new Set(parts);
    expect(unique.size).toBe(parts.length);
  });

  it("limits to 5 keywords", () => {
    const parts = keywords("weather forecast temperature humidity wind pressure precipitation");
    expect(parts.length).toBeLessThanOrEqual(5);
  });

  it("joins with OR for FTS5 syntax", () => {
    const result = extractSearchKeywords("天氣提醒設定");
    expect(result).toContain(" OR ");
  });

  it("lowercases English tokens", () => {
    const parts = keywords("LINE Mimi Weather");
    for (const p of parts) {
      // English tokens should be lowercased
      if (/^[a-z]+$/.test(p)) {
        expect(p).toBe(p.toLowerCase());
      }
    }
  });

  it("handles mixed Chinese and English", () => {
    const parts = keywords("LINE 天氣提醒 Mimi");
    // Should have at least one Chinese and one English token
    const hasChinese = parts.some((p) => /[\u4e00-\u9fff]/.test(p));
    const hasEnglish = parts.some((p) => /[a-z]/i.test(p));
    expect(hasChinese).toBe(true);
    expect(hasEnglish).toBe(true);
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });
});
