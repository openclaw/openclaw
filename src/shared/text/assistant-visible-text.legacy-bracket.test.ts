import { describe, expect, it } from "vitest";
import * as visibleText from "./assistant-visible-text.js";
import { expectPrefixParity } from "./streaming.test-support.js";
import { createTextProjection } from "./text-projection.js";

describe("stripAssistantInternalScaffolding legacy bracket blocks", () => {
  it.each([
    [
      'Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"x"}} `[/TOOL_CALL]` [/TOOL_CALL]\nAfter',
      "Before\n\nAfter",
    ],
    [
      'Before\n[\n\nTOOL_RESULT]{"output":"secret"} `[/TOOL_RESULT]` [/TOOL_RESULT]\nAfter',
      "Before\n\nAfter",
    ],
    [
      'Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"x"}}\n```\n[/TOOL_CALL]\n```\n[/TOOL_CALL]\nAfter',
      "Before\n\nAfter",
    ],
    [
      'Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"one"}} `[/TOOL_CALL]` [/TOOL_CALL]\nMiddle\n[TOOL_CALL]{tool => "web_search", args => {"query":"two"}}[/TOOL_CALL]\nAfter',
      "Before\n\nMiddle\n\nAfter",
    ],
    [
      'Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"x"}} `[/TOOL_CALL]` unclosed trailing text',
      "Before\n",
    ],
  ])("preserves canonical batch and streaming output for %j", (input, expected) => {
    const filter = visibleText.legacyBracketToolCallTextFilter;
    expect(visibleText.stripAssistantInternalScaffolding(input)).toBe(expected);
    expectPrefixParity(input, () => createTextProjection([filter]), filter.transform);
  });
});
