import { describe, expect, it } from "vitest";
import { stripAssistantInternalScaffolding } from "./assistant-visible-text.js";

describe("stripAssistantInternalScaffolding", () => {
  function expectVisibleText(input: string, expected: string) {
    expect(stripAssistantInternalScaffolding(input)).toBe(expected);
  }

  function createLiteralRelevantMemoriesCodeBlock() {
    return [
      "```xml",
      "<relevant-memories>",
      "sample",
      "</relevant-memories>",
      "```",
      "",
      "Visible text",
    ].join("\n");
  }

  function expectLiteralVisibleText(input: string) {
    expectVisibleText(input, input);
  }

  it.each([
    {
      name: "strips reasoning tags",
      input: ["<thinking>", "secret", "</thinking>", "Visible"].join("\n"),
      expected: "Visible",
    },
    {
      name: "strips relevant-memories scaffolding blocks",
      input: [
        "<relevant-memories>",
        "The following memories may be relevant to this conversation:",
        "- Internal memory note",
        "</relevant-memories>",
        "",
        "User-visible answer",
      ].join("\n"),
      expected: "User-visible answer",
    },
    {
      name: "supports relevant_memories tag variants",
      input: [
        "<relevant_memories>",
        "Internal memory note",
        "</relevant_memories>",
        "Visible",
      ].join("\n"),
      expected: "Visible",
    },
    {
      name: "hides unfinished relevant-memories blocks",
      input: ["Hello", "<relevant-memories>", "internal-only"].join("\n"),
      expected: "Hello\n",
    },
    {
      name: "trims leading whitespace after stripping scaffolding",
      input: [
        "<thinking>",
        "secret",
        "</thinking>",
        "   ",
        "<relevant-memories>",
        "internal note",
        "</relevant-memories>",
        "  Visible",
      ].join("\n"),
      expected: "Visible",
    },
    {
      name: "preserves unfinished reasoning text while still stripping memory blocks",
      input: [
        "Before",
        "<thinking>",
        "secret",
        "<relevant-memories>",
        "internal note",
        "</relevant-memories>",
        "After",
      ].join("\n"),
      expected: "Before\n\nsecret\n\nAfter",
    },
    {
      name: "keeps relevant-memories tags inside fenced code",
      input: createLiteralRelevantMemoriesCodeBlock(),
      expected: undefined,
    },
    {
      name: "keeps literal relevant-memories prose",
      input: "Use `<relevant-memories>example</relevant-memories>` literally.",
      expected: undefined,
    },
    {
      name: "strips <tool_call> XML (issue #60494)",
      input:
        'Let me check.\n\n<tool_call> {"name": "read", "arguments": {"file_path": "test.md"}} </tool_call>',
      expected: "Let me check.\n\n",
    },
    {
      name: "strips <function_calls> XML",
      input: 'Checking now. <function_calls>{"name": "exec"}</function_calls> Done.',
      expected: "Checking now.  Done.",
    },
    {
      name: "hides unclosed <tool_call> block to end-of-string (streaming)",
      input: 'Let me run.\n<tool_call>\n{"name": "find"}\n',
      expected: "Let me run.\n",
    },
    {
      name: "preserves tool_call tags inside code fences",
      input: ["```", '<tool_call> {"name": "find"} </tool_call>', "```", "", "Visible text"].join(
        "\n",
      ),
      expected: undefined,
    },
  ] as const)("$name", ({ input, expected }) => {
    if (expected === undefined) {
      expectLiteralVisibleText(input);
      return;
    }
    expectVisibleText(input, expected);
  });
});
