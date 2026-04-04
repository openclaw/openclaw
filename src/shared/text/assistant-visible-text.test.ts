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
  ] as const)("$name", ({ input, expected }) => {
    if (expected === undefined) {
      expectLiteralVisibleText(input);
      return;
    }
    expectVisibleText(input, expected);
  });

  describe("model special token stripping", () => {
    it("strips Kimi/GLM special tokens in isolation", () => {
      // Trailing space from replacement is preserved (no global trim)
      expectVisibleText(
        "<|assistant|>Here is the answer<|end|>",
        "Here is the answer ",
      );
    });

    it("strips full-width pipe DeepSeek tokens", () => {
      expectVisibleText(
        "<｜begin▁of▁sentence｜>Hello world",
        "Hello world",
      );
    });

    it("strips special tokens mixed with normal text", () => {
      // Each token is replaced with a single space; no global space
      // collapsing to avoid corrupting indentation in code blocks.
      expectVisibleText(
        "Start <|tool_call_result_begin|>middle<|tool_call_result_end|> end",
        "Start  middle  end",
      );
    });

    it("preserves special-token-like syntax inside code blocks", () => {
      expectVisibleText("Use <div>hello</div> in HTML", "Use <div>hello</div> in HTML");
    });

    it("strips special tokens combined with reasoning tags", () => {
      const input = [
        "<thinking>",
        "internal reasoning",
        "</thinking>",
        "<|assistant|>Visible response",
      ].join("\n");
      expectVisibleText(input, "Visible response");
    });

    it("preserves indentation in code blocks", () => {
      const input = [
        "<|assistant|>Here is the code:",
        "",
        "```python",
        "def foo():",
        "    if True:",
        "        return 42",
        "```",
      ].join("\n");
      const expected = [
        "Here is the code:",
        "",
        "```python",
        "def foo():",
        "    if True:",
        "        return 42",
        "```",
      ].join("\n");
      expectVisibleText(input, expected);
    });

    it("preserves special tokens inside fenced code blocks", () => {
      const input = [
        "Here are the model tokens:",
        "",
        "```",
        "<|assistant|>Hello<|end|>",
        "```",
        "",
        "As you can see above.",
      ].join("\n");
      expectVisibleText(input, input);
    });

    it("preserves special tokens inside inline code spans", () => {
      expectVisibleText(
        "The token `<|assistant|>` marks the start.",
        "The token `<|assistant|>` marks the start.",
      );
    });
  });
});
