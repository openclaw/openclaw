import { describe, expect, it } from "vitest";
import { levenshteinDistance } from "./levenshtein-distance.js";

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("returns the length of the other string when one is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  it("returns 1 for a single substitution", () => {
    expect(levenshteinDistance("cat", "bat")).toBe(1);
    expect(levenshteinDistance("abc", "abd")).toBe(1);
  });

  it("returns 1 for a single insertion", () => {
    expect(levenshteinDistance("cat", "cats")).toBe(1);
  });

  it("returns 1 for a single deletion", () => {
    expect(levenshteinDistance("cats", "cat")).toBe(1);
  });

  it("computes correct distance for known examples", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("saturday", "sunday")).toBe(3);
  });

  it("handles Unicode characters correctly", () => {
    expect(levenshteinDistance("cafe", "café")).toBe(1);
    expect(levenshteinDistance("你好", "你好吗")).toBe(1);
  });
});
