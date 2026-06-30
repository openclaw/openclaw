// Tests for Levenshtein distance algorithm.
import { describe, expect, it } from "vitest";
import { levenshteinDistance } from "./levenshtein-distance.js";

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("returns right length when left is empty", () => {
    expect(levenshteinDistance("", "hello")).toBe(5);
  });

  it("returns left length when right is empty", () => {
    expect(levenshteinDistance("hello", "")).toBe(5);
  });

  it("returns 0 for both empty", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("computes distance for substitution", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });

  it("computes distance for insertion", () => {
    expect(levenshteinDistance("cat", "cats")).toBe(1);
  });

  it("computes distance for deletion", () => {
    expect(levenshteinDistance("cats", "cat")).toBe(1);
  });

  it("computes distance for completely different strings", () => {
    expect(levenshteinDistance("abc", "xyz")).toBe(3);
  });

  it("is case sensitive", () => {
    expect(levenshteinDistance("Hello", "hello")).toBe(1);
  });

  it("handles Unicode characters", () => {
    expect(levenshteinDistance("cafe", "café")).toBe(1);
  });

  it("handles single character", () => {
    expect(levenshteinDistance("a", "b")).toBe(1);
  });
});
