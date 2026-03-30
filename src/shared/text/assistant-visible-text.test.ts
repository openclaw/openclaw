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
      name: "strips leaked tool_call scaffolding",
      input: [
        "Here is my response",
        '<tool_call>{"name":"exec","arguments":{"command":"echo test"}}</tool_call>',
      ].join(" "),
      expected: "Here is my response ",
    },
    {
      name: "hides unfinished tool_call blocks",
      input: ["Before", "<tool_call>", "incomplete..."].join(" "),
      expected: "Before ",
    },
    {
      name: "strips self-closing tool_call tags without truncating trailing text",
      input: ["Before", '<tool_call name="exec" />', "After"].join(" "),
      expected: "Before  After",
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
      name: "keeps tool_call tags inside fenced code",
      input: [
        "```xml",
        '<tool_call>{"name":"exec","arguments":{"command":"echo test"}}</tool_call>',
        "```",
        "",
        "Visible text",
      ].join("\n"),
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
