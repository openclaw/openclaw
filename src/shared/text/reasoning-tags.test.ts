import { describe, expect, it } from "vitest";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText", () => {
  describe("basic functionality", () => {
    it("returns text unchanged when no reasoning tags present", () => {
      const input = "Hello, this is a normal message.";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("strips reasoning-tag variants", () => {
      const cases = [
        {
          name: "strips proper think tags",
          input: "Hello <think>internal reasoning</think> world!",
          expected: "Hello  world!",
        },
        {
          name: "strips thinking tags",
          input: "Before <thinking>some thought</thinking> after",
          expected: "Before  after",
        },
        { name: "strips thought tags", input: "A <thought>hmm</thought> B", expected: "A  B" },
        {
          name: "strips antthinking tags",
          input: "X <antthinking>internal</antthinking> Y",
          expected: "X  Y",
        },
      ] as const;
      for (const { name, input, expected } of cases) {
        expect(stripReasoningTagsFromText(input), name).toBe(expected);
      }
    });

    it("strips multiple reasoning blocks", () => {
      const input = "<think>first</think>A<think>second</think>B";
      expect(stripReasoningTagsFromText(input)).toBe("AB");
    });
  });

  describe("code block preservation (issue #3952)", () => {
    it("preserves tags inside code examples", () => {
      const cases = [
        "Use the tag like this:\n```\n<think>reasoning</think>\n```\nThat's it!",
        "The `<think>` tag is used for reasoning. Don't forget the closing `</think>` tag.",
        "Example:\n```xml\n<think>\n  <thought>nested</thought>\n</think>\n```\nDone!",
        "Use `<think>` to open and `</think>` to close.",
        "Example:\n```\n<think>reasoning</think>\n```",
        "Use `<final>` for final answers in code: ```\n<final>42</final>\n```",
        "First `<think>` then ```\n<thinking>block</thinking>\n``` then `<thought>`",
      ] as const;
      for (const input of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(input);
      }
    });

    it("handles mixed code-tag and real-tag content", () => {
      const cases = [
        {
          input: "<think>hidden</think>Visible text with `<think>` example.",
          expected: "Visible text with `<think>` example.",
        },
        {
          input: "```\n<think>code</think>\n```\n<think>real hidden</think>visible",
          expected: "```\n<think>code</think>\n```\nvisible",
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });
  });

  describe("edge cases", () => {
    it("handles malformed tags and null-ish inputs", () => {
      const cases = [
        {
          input: "Here is how to use <think tags in your code",
          expected: "Here is how to use <think tags in your code",
        },
        {
          input: "You can start with <think and then close with </think>",
          expected: "You can start with <think and then close with",
        },
        {
          input: "A < think >content< /think > B",
          expected: "A  B",
        },
        {
          input: "",
          expected: "",
        },
        {
          input: null as unknown as string,
          expected: null,
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });

    it("handles fenced and inline code edge behavior", () => {
      const cases = [
        {
          input: "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
          expected: "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
        },
        {
          input: "Example:\n~~~js\n<think>code</think>\n~~~",
          expected: "Example:\n~~~js\n<think>code</think>\n~~~",
        },
        {
          input: "Use ``code`` with <think>hidden</think> text",
          expected: "Use ``code`` with  text",
        },
        {
          input: "Before\n```\ncode\n```\nAfter with <think>hidden</think>",
          expected: "Before\n```\ncode\n```\nAfter with",
        },
        {
          input: "```\n<think>not protected\n~~~\n</think>text",
          expected: "```\n<think>not protected\n~~~\n</think>text",
        },
        {
          input: "Start `unclosed <think>hidden</think> end",
          expected: "Start `unclosed  end",
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });

    it("handles nested and final tag behavior", () => {
      const cases = [
        {
          input: "<think>outer <think>inner</think> still outer</think>visible",
          expected: "still outervisible",
        },
        {
          input: "A<final>1</final>B<final>2</final>C",
          expected: "A1B2C",
        },
        {
          input: "`<final>` in code, <final>visible</final> outside",
          expected: "`<final>` in code, visible outside",
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });

    it("handles unicode, attributes, and case-insensitive tag names", () => {
      const cases = [
        {
          input: "你好 <think>思考 🤔</think> 世界",
          expected: "你好  世界",
        },
        {
          input: "A <think id='test' class=\"foo\">hidden</think> B",
          expected: "A  B",
        },
        {
          input: "A <THINK>hidden</THINK> <Thinking>also hidden</Thinking> B",
          expected: "A   B",
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });

    it("handles long content and pathological backtick patterns efficiently", () => {
      const longContent = "x".repeat(10000);
      expect(stripReasoningTagsFromText(`<think>${longContent}</think>visible`)).toBe("visible");

      const pathological = "`".repeat(100) + "<think>test</think>" + "`".repeat(100);
      const start = Date.now();
      stripReasoningTagsFromText(pathological);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("strict vs preserve mode", () => {
    it("applies strict and preserve modes to unclosed tags", () => {
      const input = "Before <think>unclosed content after";
      const cases = [
        { mode: "strict" as const, expected: "Before" },
        { mode: "preserve" as const, expected: "Before unclosed content after" },
      ];
      for (const { mode, expected } of cases) {
        expect(stripReasoningTagsFromText(input, { mode })).toBe(expected);
      }
    });
  });

  describe("trim options", () => {
    it("applies configured trim strategies", () => {
      const cases = [
        {
          input: "  <think>x</think>  result  <think>y</think>  ",
          expected: "result",
          opts: undefined,
        },
        {
          input: "  <think>x</think>  result  ",
          expected: "    result  ",
          opts: { trim: "none" as const },
        },
        {
          input: "  <think>x</think>  result  ",
          expected: "result  ",
          opts: { trim: "start" as const },
        },
      ] as const;
      for (const testCase of cases) {
        expect(stripReasoningTagsFromText(testCase.input, testCase.opts)).toBe(testCase.expected);
      }
    });
  });
});
