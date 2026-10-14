import { describe, expect, it } from "vitest";
import {
  stripAssistantInternalScaffolding,
  stripLegacyBracketToolCallBlocks,
} from "./assistant-visible-text.js";

describe("stripLegacyBracketToolCallBlocks", () => {
  it("strips legacy uppercase TOOL_CALL blocks when payload quotes [/TOOL_CALL] in code", () => {
    const input = [
      "Before",
      '[TOOL_CALL]{tool => "web_search", args => {"query":"x"}} `[/TOOL_CALL]` [/TOOL_CALL]',
      "After",
    ].join("\n");
    expect(stripLegacyBracketToolCallBlocks(input)).toBe("Before\n\nAfter");
    expect(stripAssistantInternalScaffolding(input)).toBe("Before\n\nAfter");
  });

  it("strips legacy uppercase TOOL_RESULT blocks when payload quotes [/TOOL_RESULT] in code", () => {
    const input = [
      "Before",
      '[TOOL_RESULT]{"output":"secret"} `[/TOOL_RESULT]` [/TOOL_RESULT]',
      "After",
    ].join("\n");
    expect(stripLegacyBracketToolCallBlocks(input)).toBe("Before\n\nAfter");
    expect(stripAssistantInternalScaffolding(input)).toBe("Before\n\nAfter");
  });

  it("strips legacy uppercase TOOL_CALL blocks when payload quotes [/TOOL_CALL] in fenced code", () => {
    const input = [
      "Before",
      '[TOOL_CALL]{tool => "web_search", args => {"query":"x"}}\n```\n[/TOOL_CALL]\n```\n[/TOOL_CALL]',
      "After",
    ].join("\n");
    expect(stripLegacyBracketToolCallBlocks(input)).toBe("Before\n\nAfter");
    expect(stripAssistantInternalScaffolding(input)).toBe("Before\n\nAfter");
  });

  it("strips multiple legacy uppercase TOOL_CALL blocks when the first quotes [/TOOL_CALL] in code", () => {
    const input = [
      "Before",
      '[TOOL_CALL]{tool => "web_search", args => {"query":"one"}} `[/TOOL_CALL]` [/TOOL_CALL]',
      "Middle",
      '[TOOL_CALL]{tool => "web_search", args => {"query":"two"}}[/TOOL_CALL]',
      "After",
    ].join("\n");
    expect(stripLegacyBracketToolCallBlocks(input)).toBe("Before\n\nMiddle\n\nAfter");
    expect(stripAssistantInternalScaffolding(input)).toBe("Before\n\nMiddle\n\nAfter");
  });

  it("hides unclosed legacy uppercase TOOL_CALL blocks when code contains a literal [/TOOL_CALL]", () => {
    const input = [
      "Before",
      '[TOOL_CALL]{tool => "web_search", args => {"query":"x"}} `[/TOOL_CALL]` unclosed trailing text',
    ].join("\n");
    expect(stripLegacyBracketToolCallBlocks(input)).toBe("Before\n");
    expect(stripAssistantInternalScaffolding(input)).toBe("Before\n");
  });
});
