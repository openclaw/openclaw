import { describe, expect, it } from "vitest";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText", () => {
  describe("basic functionality", () => {
    it("returns text unchanged when no reasoning tags present", () => {
      const input = "Hello, this is a normal message.";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("strips proper think tags", () => {
      const input = "Hello <think>internal reasoning</think> world!";
      expect(stripReasoningTagsFromText(input)).toBe("Hello  world!");
    });

    it("strips thinking tags", () => {
      const input = "Before <thinking>some thought</thinking> after";
      expect(stripReasoningTagsFromText(input)).toBe("Before  after");
    });

    it("strips thought tags", () => {
      const input = "A <thought>hmm</thought> B";
      expect(stripReasoningTagsFromText(input)).toBe("A  B");
    });

    it("strips antthinking tags", () => {
      const input = "X <antthinking>internal</antthinking> Y";
      expect(stripReasoningTagsFromText(input)).toBe("X  Y");
    });

    it("strips multiple reasoning blocks", () => {
      const input = "<think>first</think>A<think>second</think>B";
      expect(stripReasoningTagsFromText(input)).toBe("AB");
    });
  });

  describe("code block preservation (issue #3952)", () => {
    it("preserves think tags inside fenced code blocks", () => {
      const input = "Use the tag like this:\n```\n<think>reasoning</think>\n```\nThat's it!";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("preserves think tags inside inline code", () => {
      const input =
        "The `<think>` tag is used for reasoning. Don't forget the closing `</think>` tag.";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("preserves tags in fenced code blocks with language specifier", () => {
      const input = "Example:\n```xml\n<think>\n  <thought>nested</thought>\n</think>\n```\nDone!";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("handles mixed real tags and code tags", () => {
      const input = "<think>hidden</think>Visible text with `<think>` example.";
      expect(stripReasoningTagsFromText(input)).toBe("Visible text with `<think>` example.");
    });

    it("preserves both opening and closing tags in backticks", () => {
      const input = "Use `<think>` to open and `</think>` to close.";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("preserves think tags in code block at EOF without trailing newline", () => {
      const input = "Example:\n```\n<think>reasoning</think>\n```";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("preserves final tags inside code blocks", () => {
      const input = "Use `<final>` for final answers in code: ```\n<final>42</final>\n```";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("handles code block followed by real tags", () => {
      const input = "```\n<think>code</think>\n```\n<think>real hidden</think>visible";
      expect(stripReasoningTagsFromText(input)).toBe("```\n<think>code</think>\n```\nvisible");
    });

    it("handles multiple code blocks with tags", () => {
      const input = "First `<think>` then ```\n<thinking>block</thinking>\n``` then `<thought>`";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });
  });

  describe("edge cases", () => {
    it("preserves unclosed <think without angle bracket", () => {
      const input = "Here is how to use <think tags in your code";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("strips lone closing tag outside code", () => {
      const input = "You can start with <think and then close with </think>";
      expect(stripReasoningTagsFromText(input)).toBe(
        "You can start with <think and then close with",
      );
    });

    it("handles tags with whitespace", () => {
      const input = "A < think >content< /think > B";
      expect(stripReasoningTagsFromText(input)).toBe("A  B");
    });

    it("handles empty input", () => {
      expect(stripReasoningTagsFromText("")).toBe("");
    });

    it("handles null-ish input", () => {
      expect(stripReasoningTagsFromText(null as unknown as string)).toBe(null);
    });

    it("preserves think tags inside tilde fenced code blocks", () => {
      const input = "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("preserves tags in tilde block at EOF without trailing newline", () => {
      const input = "Example:\n~~~js\n<think>code</think>\n~~~";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("handles nested think patterns (first close ends block)", () => {
      const input = "<think>outer <think>inner</think> still outer</think>visible";
      expect(stripReasoningTagsFromText(input)).toBe("still outervisible");
    });

    it("strips final tag markup but preserves content (by design)", () => {
      const input = "A<final>1</final>B<final>2</final>C";
      expect(stripReasoningTagsFromText(input)).toBe("A1B2C");
    });

    it("preserves final tags in inline code (markup only stripped outside)", () => {
      const input = "`<final>` in code, <final>visible</final> outside";
      expect(stripReasoningTagsFromText(input)).toBe("`<final>` in code, visible outside");
    });

    it("handles double backtick inline code with tags", () => {
      const input = "Use ``code`` with <think>hidden</think> text";
      expect(stripReasoningTagsFromText(input)).toBe("Use ``code`` with  text");
    });

    it("handles fenced code blocks with content", () => {
      const input = "Before\n```\ncode\n```\nAfter with <think>hidden</think>";
      expect(stripReasoningTagsFromText(input)).toBe("Before\n```\ncode\n```\nAfter with");
    });

    it("does not match mismatched fence types (``` vs ~~~)", () => {
      const input = "```\n<think>not protected\n~~~\n</think>text";
      const result = stripReasoningTagsFromText(input);
      expect(result).toBe(input);
    });

    it("handles unicode content inside and around tags", () => {
      const input = "你好 <think>思考 🤔</think> 世界";
      expect(stripReasoningTagsFromText(input)).toBe("你好  世界");
    });

    it("handles very long content between tags efficiently", () => {
      const longContent = "x".repeat(10000);
      const input = `<think>${longContent}</think>visible`;
      expect(stripReasoningTagsFromText(input)).toBe("visible");
    });

    it("handles tags with attributes", () => {
      const input = "A <think id='test' class=\"foo\">hidden</think> B";
      expect(stripReasoningTagsFromText(input)).toBe("A  B");
    });

    it("is case-insensitive for tag names", () => {
      const input = "A <THINK>hidden</THINK> <Thinking>also hidden</Thinking> B";
      expect(stripReasoningTagsFromText(input)).toBe("A   B");
    });

    it("handles pathological nested backtick patterns without hanging", () => {
      const input = "`".repeat(100) + "<think>test</think>" + "`".repeat(100);
      const start = Date.now();
      stripReasoningTagsFromText(input);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it("handles unclosed inline code gracefully", () => {
      const input = "Start `unclosed <think>hidden</think> end";
      const result = stripReasoningTagsFromText(input);
      expect(result).toBe("Start `unclosed  end");
    });
  });

  describe("strict vs preserve mode", () => {
    it("strict mode truncates on unclosed tag", () => {
      const input = "Before <think>unclosed content after";
      expect(stripReasoningTagsFromText(input, { mode: "strict" })).toBe("Before");
    });

    it("preserve mode keeps content after unclosed tag", () => {
      const input = "Before <think>unclosed content after";
      expect(stripReasoningTagsFromText(input, { mode: "preserve" })).toBe(
        "Before unclosed content after",
      );
    });
  });

  describe("trim options", () => {
    it("trims both sides by default", () => {
      const input = "  <think>x</think>  result  <think>y</think>  ";
      expect(stripReasoningTagsFromText(input)).toBe("result");
    });

    it("trim=none preserves whitespace", () => {
      const input = "  <think>x</think>  result  ";
      expect(stripReasoningTagsFromText(input, { trim: "none" })).toBe("    result  ");
    });

    it("trim=start only trims start", () => {
      const input = "  <think>x</think>  result  ";
      expect(stripReasoningTagsFromText(input, { trim: "start" })).toBe("result  ");
    });
  });
});
