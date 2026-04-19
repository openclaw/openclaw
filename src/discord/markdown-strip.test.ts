import { describe, expect, it } from "vitest";
import { stripHorizontalRules } from "./markdown-strip.js";

describe("stripHorizontalRules", () => {
  it("strips --- horizontal rules", () => {
    expect(stripHorizontalRules("before\n---\nafter")).toBe("before\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\nafter");
  });

  it("strips *** horizontal rules", () => {
    expect(stripHorizontalRules("before\n***\nafter")).toBe("before\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\nafter");
  });

  it("strips ___ horizontal rules", () => {
    expect(stripHorizontalRules("before\n___\nafter")).toBe("before\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\nafter");
  });

  it("strips rules with spaces between characters", () => {
    expect(stripHorizontalRules("before\n- - -\nafter")).toBe("before\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\nafter");
    expect(stripHorizontalRules("before\n* * *\nafter")).toBe("before\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\nafter");
  });

  it("strips rules with more than 3 characters", () => {
    expect(stripHorizontalRules("before\n-----\nafter")).toBe("before\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\nafter");
  });

  it("does not strip rules inside code blocks", () => {
    const text = "before\n```\n---\n```\nafter";
    expect(stripHorizontalRules(text)).toBe(text);
  });

  it("does not strip lines that are not rules", () => {
    const text = "before\n--\nafter";
    expect(stripHorizontalRules(text)).toBe(text);
  });

  it("returns empty string unchanged", () => {
    expect(stripHorizontalRules("")).toBe("");
  });

  it("handles multiple rules", () => {
    expect(stripHorizontalRules("a\n---\nb\n***\nc")).toBe(
      "a\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\nb\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\nc",
    );
  });
});
