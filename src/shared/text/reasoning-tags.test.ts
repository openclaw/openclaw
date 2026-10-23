import { describe, expect, it, vi } from "vitest";
import * as markdownCore from "../../../packages/markdown-core/src/reasoning-tags.js";
import * as finalTags from "./final-tags.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText", () => {
  it("skips canonical tag scans for ordinary markup and comparisons", () => {
    const source = "  <article>Array<string>: value < 100 and other > 0.</article>\n".repeat(64);
    const reasoning = vi.spyOn(markdownCore, "scanReasoningTags");
    const final = vi.spyOn(finalTags, "findFinalTagMatches");
    try {
      expect(stripReasoningTagsFromText(source)).toBe(source);
      expect(reasoning).not.toHaveBeenCalled();
      expect(final).not.toHaveBeenCalled();
      expect(stripReasoningTagsFromText("<think>hidden</think>Answer")).toBe("Answer");
      expect(reasoning).toHaveBeenCalled();
      expect(final).toHaveBeenCalled();
    } finally {
      reasoning.mockRestore();
      final.mockRestore();
    }
  });

  describe("basic functionality", () => {
    it.each(markdownCore.REASONING_TAG_NAMES)("recognizes the %s provider tag", (name) => {
      expect(stripReasoningTagsFromText(`<${name}>hidden</${name}>Answer`)).toBe("Answer");
    });

    it.each([
      [
        "never recovers nested unclosed internal reflection as visible text",
        "<thinking>outer<internal>private reflection",
        "",
      ],
    ] as const)("%s", (_name, input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });
  });

  describe("code block preservation (issue #3952)", () => {
    it.each<[string, string, string?]>([
      [
        "preserves final tags inside code examples",
        "Use `<final>` for final answers in code:\n```\n<final>42</final>\n```",
      ],
      [
        "strips real tags after fenced code block",
        "```\n<think>code</think>\n```\n<think>real hidden</think>visible",
        "```\n<think>code</think>\n```\nvisible",
      ],
    ] as const)("%s", (_name, input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected ?? input);
    });
  });

  describe("edge cases", () => {
    it.each([["", ""]] as const)("handles malformed or empty input %j", (input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });

    it.each([
      ["A <final/>visible <final data-model='gemini'>answer</final> B", "A visible answer B"],
      ["  <final-result>visible</final-result>  ", "  <final-result>visible</final-result>  "],
      ['A <final reason="a>b">visible B', 'A <final reason="a>b">visible B'],
      ["  < \u00a0AnTmL:ThiNking >hidden< / antml:thinking >Answer  ", "Answer"],
      ["  < / FINAL >Answer  ", "Answer"],
      ['<thinking x="<internal>private reflection</internal>', '<thinking x="'],
      ["  <thinking", "  <thinking"],
    ] as const)("handles nested/final tag behavior: %j", (input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });
  });

  describe("strict vs preserve mode", () => {
    it.each([
      [
        "keeps strict mode from leaking unclosed trailing reasoning after visible text",
        "Before <think>unclosed content after",
        "Before",
        { mode: "strict" as const },
      ],
      [
        "does not recover internal reflection in preserve mode",
        "<internal>private reflection",
        "",
        { mode: "preserve" as const },
      ],
    ] as const)("%s", (_name, input, expected, opts) => {
      expect(stripReasoningTagsFromText(input, opts)).toBe(expected);
    });
  });

  describe("trim options", () => {
    it.each([
      [
        "keeps final-only whitespace with trim=none",
        "  <final>result</final>  ",
        "  result  ",
        { trim: "none" as const },
      ],
      [
        "supports trim=start",
        "  <think>x</think>  result  ",
        "result  ",
        { trim: "start" as const },
      ],
    ] as const)("%s", (_name, input, expected, opts) => {
      expect(stripReasoningTagsFromText(input, opts)).toBe(expected);
    });
  });
});
