import { describe, expect, it } from "vitest";
import { appendUniqueSuffix } from "./join-segments.js";

describe("appendUniqueSuffix", () => {
  it("appends non-overlapping strings", () => {
    expect(appendUniqueSuffix("hello", " world")).toBe("hello world");
  });

  it("merges exact overlapping strings", () => {
    expect(appendUniqueSuffix("hello world", "world")).toBe("hello world");
  });

  it("merges partial overlapping strings at boundaries", () => {
    expect(appendUniqueSuffix("I hear you", "you - hello")).toBe("I hear you - hello");
  });

  it("does not merge short accidental overlaps not at boundaries", () => {
    // "bo" + "ok" should be "book", not merged to "bk" or something if they overlap "o"
    // "bo" ends in "o", "ok" starts with "o". Overlap is "o".
    // 1-char overlap "o" is NOT at base boundary (preceded by "b") and NOT at suffix boundary (followed by "k").
    expect(appendUniqueSuffix("bo", "ok")).toBe("book");
  });

  it("merges long overlaps regardless of boundaries", () => {
    const longBase = "This is a very long string that should definitely be merged";
    const longSuffix = "long string that should definitely be merged and then some";
    expect(appendUniqueSuffix(longBase, longSuffix)).toBe(
      "This is a very long string that should definitely be merged and then some",
    );
  });

  it("respects minOverlap", () => {
    expect(appendUniqueSuffix("abcde", "cdefg", { minOverlap: 4 })).toBe("abcdecdefg");
    // Long overlaps (15+) merge even without boundaries
    const base = "This is a very long string";
    const suffix = "very long string and more";
    expect(appendUniqueSuffix(base, suffix, { minOverlap: 10 })).toBe(
      "This is a very long string and more",
    );
  });

  it("handles empty inputs", () => {
    expect(appendUniqueSuffix("", "hello")).toBe("hello");
    expect(appendUniqueSuffix("hello", "")).toBe("hello");
  });
});
