import { describe, expect, it } from "vitest";
import { convertNewlinesForDiscord } from "./newline-breaks.js";

describe("convertNewlinesForDiscord", () => {
  it("returns empty string unchanged", () => {
    expect(convertNewlinesForDiscord("")).toBe("");
  });

  it("returns text without newlines unchanged", () => {
    expect(convertNewlinesForDiscord("hello world")).toBe("hello world");
  });

  it("converts a single newline to a double newline", () => {
    expect(convertNewlinesForDiscord("line1\nline2")).toBe("line1\n\nline2");
  });

  it("converts multiple isolated single newlines", () => {
    expect(convertNewlinesForDiscord("a\nb\nc")).toBe("a\n\nb\n\nc");
  });

  it("preserves existing double newlines", () => {
    expect(convertNewlinesForDiscord("line1\n\nline2")).toBe("line1\n\nline2");
  });

  it("preserves triple-or-more newlines", () => {
    expect(convertNewlinesForDiscord("line1\n\n\nline2")).toBe("line1\n\n\nline2");
  });

  it("handles mixed single and double newlines", () => {
    expect(convertNewlinesForDiscord("a\nb\n\nc\nd")).toBe("a\n\nb\n\nc\n\nd");
  });

  it("does not modify content inside fenced code blocks", () => {
    const input = "before\n```\ncode\nblock\n```\nafter";
    const expected = "before\n\n```\ncode\nblock\n```\n\nafter";
    expect(convertNewlinesForDiscord(input)).toBe(expected);
  });

  it("handles multiple fenced code blocks", () => {
    const input = "a\nb\n```\nx\ny\n```\nc\nd\n```js\ne\nf\n```\ng";
    const expected = "a\n\nb\n\n```\nx\ny\n```\n\nc\n\nd\n\n```js\ne\nf\n```\n\ng";
    expect(convertNewlinesForDiscord(input)).toBe(expected);
  });

  it("handles text with only code blocks", () => {
    const input = "```\nonly\ncode\n```";
    expect(convertNewlinesForDiscord(input)).toBe(input);
  });

  it("converts a trailing single newline to double", () => {
    // A trailing \n is isolated (not preceded or followed by \n) so it becomes \n\n.
    expect(convertNewlinesForDiscord("hello\n")).toBe("hello\n\n");
  });

  it("preserves a trailing double newline", () => {
    expect(convertNewlinesForDiscord("hello\n\n")).toBe("hello\n\n");
  });
});
