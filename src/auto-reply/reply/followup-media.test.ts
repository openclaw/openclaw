import { describe, expect, it } from "vitest";
import {
  _findLastOccurrenceBeforeFileBlocks as findLastOccurrenceBeforeFileBlocks,
  _normalizeUpdatedBody as normalizeUpdatedBody,
  _rebuildQueuedPromptWithMediaUnderstanding as rebuildQueuedPromptWithMediaUnderstanding,
} from "./followup-media.js";

const FILE_BLOCK = '<file name="doc.pdf" type="application/pdf">\nPDF content\n</file>';

describe("findLastOccurrenceBeforeFileBlocks", () => {
  it("returns -1 for empty search", () => {
    expect(findLastOccurrenceBeforeFileBlocks("hello", "")).toBe(-1);
  });

  it("finds last occurrence in body region before file blocks", () => {
    const value = `hello world hello\n${FILE_BLOCK}`;
    // "hello" appears at 0 and 12 — both before the file block
    expect(findLastOccurrenceBeforeFileBlocks(value, "hello")).toBe(12);
  });

  it("does not match inside file block content", () => {
    const value = `some text\n${FILE_BLOCK}\nPDF content`;
    // "PDF content" appears in the file block and after it, but the body region
    // (before <file) is just "some text\n" — no match there.
    expect(findLastOccurrenceBeforeFileBlocks(value, "PDF content")).toBe(-1);
  });

  it("uses lastIndexOf in fallback when search itself contains file blocks", () => {
    // When the search string contains a <file> block, it can't appear in the
    // body-only region, so the fallback searches the full value.
    const bodyWithFile = `caption\n${FILE_BLOCK}`;
    const value = `previous\n${bodyWithFile}\nlater\n${bodyWithFile}`;
    // Should find the *last* (trailing) occurrence
    const expected = value.lastIndexOf(bodyWithFile);
    expect(findLastOccurrenceBeforeFileBlocks(value, bodyWithFile)).toBe(expected);
    expect(expected).toBeGreaterThan(value.indexOf(bodyWithFile));
  });

  it("returns index when no file blocks exist in value", () => {
    expect(findLastOccurrenceBeforeFileBlocks("abc abc", "abc")).toBe(4);
  });
});

describe("normalizeUpdatedBody", () => {
  it("returns empty string when updatedBody is empty", () => {
    expect(normalizeUpdatedBody({ originalBody: "foo", updatedBody: "" })).toBe("");
  });

  it("returns updatedBody when originalBody is empty", () => {
    expect(normalizeUpdatedBody({ updatedBody: "hello" })).toBe("hello");
  });

  it("strips directives when updatedBody equals originalBody", () => {
    const body = "/think high tell me a joke";
    const result = normalizeUpdatedBody({ originalBody: body, updatedBody: body });
    expect(result).toBe("tell me a joke");
  });

  it("does not corrupt file block content during directive cleanup", () => {
    const originalBody = "/think high tell me about this file";
    // updatedBody has the original body plus a file block appended by media processing
    const updatedBody = `${originalBody}\n${FILE_BLOCK}`;
    const result = normalizeUpdatedBody({ originalBody, updatedBody });
    // The directive should be stripped from the body portion, file block preserved
    expect(result).toContain("tell me about this file");
    expect(result).toContain(FILE_BLOCK);
    expect(result).not.toContain("/think");
  });

  it("replaces in body region, not inside file blocks", () => {
    const originalBody = "PDF content";
    const updatedBody = `PDF content\n<file name="doc.pdf" type="application/pdf">\nPDF content\n</file>`;
    // The replacement should target the body region "PDF content" before the
    // file block, not the "PDF content" inside the <file> block.
    const result = normalizeUpdatedBody({ originalBody, updatedBody });
    // With no directives to strip, original === cleaned, updatedBody !== originalBody
    // because updatedBody has the file block appended.  The replacement targets the
    // body-region occurrence.
    expect(result).toContain('<file name="doc.pdf"');
    expect(result).toContain("PDF content\n</file>");
  });
});

describe("rebuildQueuedPromptWithMediaUnderstanding", () => {
  it("replaces original body with updated body in prompt", () => {
    const result = rebuildQueuedPromptWithMediaUnderstanding({
      prompt: "thread context\nhello world",
      originalBody: "hello world",
      updatedBody: 'hello world\n<file name="a.pdf">data</file>',
    });
    expect(result).toContain('<file name="a.pdf">data</file>');
    expect(result).toContain("thread context");
  });

  it("preserves file blocks in thread history when body is replaced", () => {
    const prompt = `history\n<file name="old.pdf">old</file>\nhello world`;
    const result = rebuildQueuedPromptWithMediaUnderstanding({
      prompt,
      originalBody: "hello world",
      updatedBody: "hello world transcribed",
    });
    // The old file block from history should be preserved since updatedBody
    // has no file blocks of its own.
    expect(result).toContain('<file name="old.pdf">old</file>');
    expect(result).toContain("hello world transcribed");
  });
});
