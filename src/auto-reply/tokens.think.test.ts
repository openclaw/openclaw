import { describe, it, expect } from "vitest";
import { stripThinkPrefix } from "./tokens.js";

describe("stripThinkPrefix", () => {
  it("should return unchanged text when no [THINK] prefix", () => {
    const result = stripThinkPrefix("Hello world");
    expect(result).toEqual({ text: "Hello world", hadThinkPrefix: false });
  });

  it("should strip entire text when [THINK] with no closing tag", () => {
    const result = stripThinkPrefix("[THINK] Let me check the database...");
    expect(result).toEqual({ text: "", hadThinkPrefix: true });
  });

  it("should strip think block and return remainder with closing tag", () => {
    const result = stripThinkPrefix("[THINK] internal reasoning [/THINK] Here is my answer");
    expect(result).toEqual({ text: "Here is my answer", hadThinkPrefix: true });
  });

  it("should suppress when closing tag but nothing after", () => {
    const result = stripThinkPrefix("[THINK] just thinking [/THINK]");
    expect(result).toEqual({ text: "", hadThinkPrefix: true });
  });

  it("should suppress when closing tag with only whitespace after", () => {
    const result = stripThinkPrefix("[THINK] just thinking [/THINK]   ");
    expect(result).toEqual({ text: "", hadThinkPrefix: true });
  });

  it("should be case-insensitive", () => {
    expect(stripThinkPrefix("[think] lower case")).toEqual({ text: "", hadThinkPrefix: true });
    expect(stripThinkPrefix("[Think] mixed case")).toEqual({ text: "", hadThinkPrefix: true });
    expect(stripThinkPrefix("[THINK] upper case")).toEqual({ text: "", hadThinkPrefix: true });
  });

  it("should handle leading whitespace", () => {
    const result = stripThinkPrefix("  [THINK] reasoning with indent");
    expect(result).toEqual({ text: "", hadThinkPrefix: true });
  });

  it("should NOT strip [THINK] that appears mid-text", () => {
    const result = stripThinkPrefix("Hello [THINK] this is not at the start");
    expect(result).toEqual({
      text: "Hello [THINK] this is not at the start",
      hadThinkPrefix: false,
    });
  });

  it("should handle [THINK] alone", () => {
    const result = stripThinkPrefix("[THINK]");
    expect(result).toEqual({ text: "", hadThinkPrefix: true });
  });

  it("should handle case-insensitive closing tag", () => {
    const result = stripThinkPrefix("[THINK] reasoning [/think] actual reply");
    expect(result).toEqual({ text: "actual reply", hadThinkPrefix: true });
  });
});
