import { afterEach, expect, it, vi } from "vitest";
import * as markdownCore from "../../../packages/markdown-core/src/reasoning-tags-batch.js";
import * as finalTags from "./final-tags.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

afterEach(() => vi.restoreAllMocks());

it("skips canonical tag scans for ordinary markup and comparisons", () => {
  const source = "  <article>Array<string>: value < 100 and other > 0.</article>\n".repeat(64);
  const reasoning = vi.spyOn(markdownCore, "scanReasoningTags");
  const final = vi.spyOn(finalTags, "findFinalTagMatches");
  expect(stripReasoningTagsFromText(source)).toBe(source);
  expect(reasoning).not.toHaveBeenCalled();
  expect(final).not.toHaveBeenCalled();
  expect(stripReasoningTagsFromText("<think>hidden</think>Answer")).toBe("Answer");
  expect(reasoning).toHaveBeenCalled();
  expect(final).toHaveBeenCalled();
});

it.each(markdownCore.REASONING_TAG_NAMES)("recognizes the %s provider tag", (name) => {
  expect(stripReasoningTagsFromText(`<${name}>hidden</${name}>Answer`)).toBe("Answer");
});

it.each([
  ["<thinking>outer<internal>private reflection", ""],
  ["", ""],
  ["A <final/>visible <final data-model='gemini'>answer</final> B", "A visible answer B"],
  ["  <final-result>visible</final-result>  ", "  <final-result>visible</final-result>  "],
  ['A <final reason="a>b">visible B', 'A <final reason="a>b">visible B'],
  ["  < \u00a0AnTmL:ThiNking >hidden< / antml:thinking >Answer  ", "Answer"],
  ["  < / FINAL >Answer  ", "Answer"],
  ['<thinking x="<internal>private reflection</internal>', '<thinking x="'],
  ["  <thinking", "  <thinking"],
])("handles nested, final, or malformed tags: %j", (input, expected) => {
  expect(stripReasoningTagsFromText(input)).toBe(expected);
});

// Issue #3952: code examples remain literal while real tags are removed.
const code = "```\n<think>code</think>\n```\n";
it.each([
  ["Use `<final>` for final answers in code:\n```\n<final>42</final>\n```"],
  [`${code}<think>real hidden</think>visible`, `${code}visible`],
])("preserves code examples: %j", (input, expected = input) => {
  expect(stripReasoningTagsFromText(input)).toBe(expected);
});

it.each([
  ["Before <think>unclosed content after", "Before", { mode: "strict" }],
  ["<internal>private reflection", "", { mode: "preserve" }],
  ["  <final>result</final>  ", "  result  ", { trim: "none" }],
  ["  <think>x</think>  result  ", "result  ", { trim: "start" }],
] as const)("applies mode and trim options: %j", (input, expected, options) => {
  expect(stripReasoningTagsFromText(input, options)).toBe(expected);
});
