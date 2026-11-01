import { describe, expect, it } from "vitest";
import { stripAssistantInternalScaffolding } from "./assistant-visible-text.js";

describe("stripAssistantInternalScaffolding legacy bracket blocks", () => {
  it.each([
    [
      "strips legacy uppercase TOOL_CALL blocks when payload quotes [/TOOL_CALL] in code",
      'Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"x"}} `[/TOOL_CALL]` [/TOOL_CALL]\nAfter',
      "Before\n\nAfter",
    ],
    [
      "strips legacy uppercase TOOL_RESULT blocks when payload quotes [/TOOL_RESULT] in code",
      'Before\n[TOOL_RESULT]{"output":"secret"} `[/TOOL_RESULT]` [/TOOL_RESULT]\nAfter',
      "Before\n\nAfter",
    ],
    [
      "strips legacy uppercase TOOL_CALL blocks when payload quotes [/TOOL_CALL] in fenced code",
      'Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"x"}}\n```\n[/TOOL_CALL]\n```\n[/TOOL_CALL]\nAfter',
      "Before\n\nAfter",
    ],
    [
      "strips multiple legacy uppercase TOOL_CALL blocks when the first quotes [/TOOL_CALL] in code",
      'Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"one"}} `[/TOOL_CALL]` [/TOOL_CALL]\nMiddle\n[TOOL_CALL]{tool => "web_search", args => {"query":"two"}}[/TOOL_CALL]\nAfter',
      "Before\n\nMiddle\n\nAfter",
    ],
    [
      "hides unclosed legacy uppercase TOOL_CALL blocks when code contains a literal [/TOOL_CALL]",
      'Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"x"}} `[/TOOL_CALL]` unclosed trailing text',
      "Before\n",
    ],
  ])("%s", (_name, input, expected) => {
    expect(stripAssistantInternalScaffolding(input)).toBe(expected);
  });
});
