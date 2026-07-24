import { describe, expect, it } from "vitest";
import { levenshteinDistance } from "./levenshtein-distance.js";

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("returns 0 for two empty strings", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("returns the length when left is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("returns the length when right is empty", () => {
    expect(levenshteinDistance("abc", "")).toBe(3);
  });

  it("computes distance for single-character difference", () => {
    expect(levenshteinDistance("a", "b")).toBe(1);
    expect(levenshteinDistance("abc", "abd")).toBe(1);
  });

  it("computes the classic kitten-sitting distance", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });

  it("computes distance for insertion", () => {
    expect(levenshteinDistance("cat", "cats")).toBe(1);
  });

  it("computes distance for deletion", () => {
    expect(levenshteinDistance("cats", "cat")).toBe(1);
  });

  it("is case-sensitive", () => {
    expect(levenshteinDistance("Hello", "hello")).toBe(1);
  });

  it("handles Unicode characters", () => {
    // U+00E9 (é) vs U+0065 (e) — one precomposed char, one base char
    expect(levenshteinDistance("café", "cafe")).toBe(1);
  });

  it("handles longer strings", () => {
    expect(levenshteinDistance("abcdefghij", "abcdefgxij")).toBe(1);
  });
});
