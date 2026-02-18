import { describe, expect, it } from "vitest";
import { expandQueryForFts, extractKeywords } from "./query-expansion.js";

describe("extractKeywords", () => {
  it("extracts keywords from English conversational query", () => {
    const keywords = extractKeywords("that thing we discussed about the API");
    expect(keywords).toContain("discussed");
    expect(keywords).toContain("api");
    // Should not include stop words
    expect(keywords).not.toContain("that");
    expect(keywords).not.toContain("thing");
    expect(keywords).not.toContain("we");
    expect(keywords).not.toContain("about");
    expect(keywords).not.toContain("the");
  });

  it("extracts keywords from Chinese conversational query", () => {
    const keywords = extractKeywords("之前讨论的那个方案");
    expect(keywords).toContain("讨论");
    expect(keywords).toContain("方案");
    // Should not include stop words
    expect(keywords).not.toContain("之前");
    expect(keywords).not.toContain("的");
    expect(keywords).not.toContain("那个");
  });

  it("extracts keywords from mixed language query", () => {
    const keywords = extractKeywords("昨天讨论的 API design");
    expect(keywords).toContain("讨论");
    expect(keywords).toContain("api");
    expect(keywords).toContain("design");
  });

  it("returns specific technical terms", () => {
    const keywords = extractKeywords("what was the solution for the CFR bug");
    expect(keywords).toContain("solution");
    expect(keywords).toContain("cfr");
    expect(keywords).toContain("bug");
  });

  it("handles empty query", () => {
    expect(extractKeywords("")).toEqual([]);
    expect(extractKeywords("   ")).toEqual([]);
  });

  it("handles query with only stop words", () => {
    const keywords = extractKeywords("the a an is are");
    expect(keywords.length).toBe(0);
  });

  it("removes duplicate keywords", () => {
    const keywords = extractKeywords("test test testing");
    const testCount = keywords.filter((k) => k === "test").length;
    expect(testCount).toBe(1);
  });
});

describe("expandQueryForFts", () => {
  it("returns original query and extracted keywords", () => {
    const result = expandQueryForFts("that API we discussed");
    expect(result.original).toBe("that API we discussed");
    expect(result.keywords).toContain("api");
    expect(result.keywords).toContain("discussed");
  });

  it("builds expanded OR query for FTS", () => {
    const result = expandQueryForFts("the solution for bugs");
    expect(result.expanded).toContain("OR");
    expect(result.expanded).toContain("solution");
    expect(result.expanded).toContain("bugs");
  });

  it("returns original query when no keywords extracted", () => {
    const result = expandQueryForFts("the");
    expect(result.keywords.length).toBe(0);
    expect(result.expanded).toBe("the");
  });
});
