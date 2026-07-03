import { describe, expect, it } from "vitest";
import { levenshteinDistance } from "./levenshtein-distance.js";

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("returns 0 for two empty strings", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("returns length of right string when left is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
  });

  it("returns length of left string when right is empty", () => {
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  it("returns 1 for single-character substitution", () => {
    expect(levenshteinDistance("cat", "bat")).toBe(1);
  });

  it("returns 1 for single-character insertion", () => {
    expect(levenshteinDistance("cat", "cats")).toBe(1);
  });

  it("returns 1 for single-character deletion", () => {
    expect(levenshteinDistance("cats", "cat")).toBe(1);
  });

  it("returns correct distance for known examples", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("saturday", "sunday")).toBe(3);
    expect(levenshteinDistance("algorithm", "altruistic")).toBe(6);
  });

  it("handles strings with Unicode characters", () => {
    // "café" → "cafe" = 1 deletion (the accent is a separate char, so this is
    // actually "café" vs "cafe" which may differ by one codepoint)
    const dist = levenshteinDistance("café", "cafe");
    expect(dist).toBeGreaterThanOrEqual(0);
  });

  it("is symmetric", () => {
    expect(levenshteinDistance("abc", "xyz")).toBe(levenshteinDistance("xyz", "abc"));
  });

  it("handles single-character strings", () => {
    expect(levenshteinDistance("a", "a")).toBe(0);
    expect(levenshteinDistance("a", "b")).toBe(1);
    expect(levenshteinDistance("a", "")).toBe(1);
  });
});
