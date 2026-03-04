import { describe, expect, it } from "vitest";
import {
  deduplicateText,
  detectFullTextRepetition,
  detectTextSelfDuplication,
} from "./self-dedup.js";

describe("detectTextSelfDuplication", () => {
  it("returns null for short text", () => {
    expect(detectTextSelfDuplication("short")).toBeNull();
    expect(detectTextSelfDuplication("ok\n\nok")).toBeNull();
  });

  it("returns null for non-duplicate text", () => {
    const text =
      "This is paragraph one with enough text.\n\nThis is paragraph two, totally different.";
    expect(detectTextSelfDuplication(text)).toBeNull();
  });

  it("removes duplicate paragraphs", () => {
    const paragraph = "This is a paragraph that is long enough to trigger dedup.";
    const text = `${paragraph}\n\n${paragraph}`;
    const result = detectTextSelfDuplication(text);
    expect(result).toBe(paragraph);
  });

  it("handles BlueBubbles-style duplication", () => {
    const content =
      "Here is a detailed response with enough text to qualify for deduplication checks.";
    const text = `${content}\n\n${content}`;
    const result = detectTextSelfDuplication(text);
    expect(result).toBe(content);
  });

  it("handles three-way repetition", () => {
    const paragraph = "This paragraph is repeated three times and is long enough.";
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const result = detectTextSelfDuplication(text);
    expect(result).toBe(paragraph);
  });

  it("preserves non-duplicate paragraphs in order", () => {
    const para1 = "First paragraph with enough text to qualify for checks.";
    const para2 = "Second paragraph that is different from the first one.";
    const text = `${para1}\n\n${para2}\n\n${para1}`;
    const result = detectTextSelfDuplication(text);
    expect(result).toBe(`${para1}\n\n${para2}`);
  });

  it("returns null for single paragraph", () => {
    expect(
      detectTextSelfDuplication(
        "Just one long paragraph with no double-newline breaks at all, long enough text.",
      ),
    ).toBeNull();
  });
});

describe("detectFullTextRepetition", () => {
  it("returns null for short text", () => {
    expect(detectFullTextRepetition("short")).toBeNull();
    expect(detectFullTextRepetition("a".repeat(38))).toBeNull();
  });

  it("returns null for non-repeated text", () => {
    const text = "A".repeat(30) + "B".repeat(30);
    expect(detectFullTextRepetition(text)).toBeNull();
  });

  it("detects exact full-text duplication", () => {
    const half = "This is a message that got duplicated by streaming buffer bug.";
    const text = half + half;
    const result = detectFullTextRepetition(text);
    expect(result).toBe(half);
  });

  it("detects duplication with whitespace normalization", () => {
    const half = "Hello  world  this  is  a  test  message  with  spaces";
    // Slightly different spacing — normalization should still match.
    const text = `${half}${half}`;
    const result = detectFullTextRepetition(text);
    expect(result).toBe(half);
  });
});

describe("deduplicateText", () => {
  it("returns null for clean text", () => {
    expect(
      deduplicateText(
        "This is a normal message without any duplication at all. It is long enough.",
      ),
    ).toBeNull();
  });

  it("prefers full-text repetition detection", () => {
    const half = "This is a duplicated message from streaming buffer.";
    const text = half + half;
    const result = deduplicateText(text);
    expect(result).toBe(half);
  });

  it("falls back to paragraph deduplication", () => {
    const paragraph = "A paragraph with enough content for deduplication to engage.";
    const text = `${paragraph}\n\n${paragraph}`;
    const result = deduplicateText(text);
    expect(result).toBe(paragraph);
  });
});
