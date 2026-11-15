import { expect, it } from "vitest";
import { formatFencedCodeBlock, formatInlineCodeSpan } from "./markdown-code.js";

it.each([
  ["a `b` c", "``a `b` c``"],
  ["x ``y`` z", "```x ``y`` z```"],
  ["`edge", "`` `edge ``"],
  ["edge`", "`` edge` ``"],
  [" 1 ", "`  1  `"],
  [" `code` ", "``  `code`  ``"],
  ["   ", "`   `"],
  [" \t ", "`  \t  `"],
  [" \u00a0 ", "`  \u00a0  `"],
] as const)("formats inline code span %j", (input, expected) => {
  expect(formatInlineCodeSpan(input)).toBe(expected);
});

it("formatFencedCodeBlock keeps a fence longer than inner runs", () => {
  expect(formatFencedCodeBlock("a ``b`` c")).toBe("```\na ``b`` c\n```");
});
