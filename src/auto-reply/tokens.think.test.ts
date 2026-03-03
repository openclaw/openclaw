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

  it("should preserve trailing whitespace/formatting in reply after closing tag", () => {
    const result = stripThinkPrefix("[THINK] reasoning [/THINK] reply\n    indented code\n");
    expect(result).toEqual({ text: "reply\n    indented code\n", hadThinkPrefix: true });
  });

  it("should preserve markdown formatting after closing tag", () => {
    const result = stripThinkPrefix("[THINK] internal [/THINK] - item 1\n  - item 2\n");
    expect(result).toEqual({ text: "- item 1\n  - item 2\n", hadThinkPrefix: true });
  });

  it("should strip multiple consecutive think blocks", () => {
    const result = stripThinkPrefix(
      "[THINK] step 1 [/THINK] [THINK] step 2 [/THINK] Here is the answer",
    );
    expect(result).toEqual({ text: "Here is the answer", hadThinkPrefix: true });
  });

  it("should strip multiple [THINKING] blocks", () => {
    const result = stripThinkPrefix(
      "[THINKING] first [/THINKING] [THINKING] second [/THINKING] final reply",
    );
    expect(result).toEqual({ text: "final reply", hadThinkPrefix: true });
  });

  it("should strip mixed [THINK] and [THINKING] blocks", () => {
    const result = stripThinkPrefix("[THINK] first [/THINK] [THINKING] second [/THINKING] answer");
    expect(result).toEqual({ text: "answer", hadThinkPrefix: true });
  });

  it("should suppress entirely when last think block has no closing tag", () => {
    const result = stripThinkPrefix("[THINK] step 1 [/THINK] [THINK] still thinking...");
    expect(result).toEqual({ text: "", hadThinkPrefix: true });
  });

  it("should handle non-ASCII content inside think blocks (Unicode safety)", () => {
    const result = stripThinkPrefix("[THINK] überlegung mit ß [/THINK] Antwort");
    expect(result).toEqual({ text: "Antwort", hadThinkPrefix: true });
  });

  it("should handle Unicode characters that change length on toUpperCase", () => {
    // ß uppercases to SS (1 char → 2 chars) — regression test for index mismatch
    const result = stripThinkPrefix("[THINK]ß[/THINK]X");
    expect(result).toEqual({ text: "X", hadThinkPrefix: true });
  });
});
