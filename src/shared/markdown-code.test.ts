import { describe, expect, it } from "vitest";
import { formatFencedCodeBlock, formatInlineCodeSpan } from "./markdown-code.js";

describe("formatInlineCodeSpan", () => {
  it("grows the delimiter past embedded backtick runs", () => {
    expect(formatInlineCodeSpan("a `b` c")).toBe("``a `b` c``");
    expect(formatInlineCodeSpan("x ``y`` z")).toBe("```x ``y`` z```");
  });

  it("pads when content starts or ends with a backtick", () => {
    expect(formatInlineCodeSpan("`edge")).toBe("`` `edge ``");
    expect(formatInlineCodeSpan("edge`")).toBe("`` edge` ``");
  });

  it("guards edge spaces against CommonMark one-space stripping", () => {
    expect(formatInlineCodeSpan(" 1 ")).toBe("`  1  `");
    expect(formatInlineCodeSpan(" `code` ")).toBe("``  `code`  ``");
  });

  it("does not pad content whose spaces are safe", () => {
    expect(formatInlineCodeSpan(" leading")).toBe("` leading`");
    expect(formatInlineCodeSpan("trailing ")).toBe("`trailing `");
    expect(formatInlineCodeSpan("   ")).toBe("`   `");
  });

  it("guards edge spaces held apart by tabs or non-ASCII spaces", () => {
    expect(formatInlineCodeSpan(" \t ")).toBe("`  \t  `");
    expect(formatInlineCodeSpan(" a\tb ")).toBe("`  a\tb  `");
    expect(formatInlineCodeSpan(" \u00a0 ")).toBe("`  \u00a0  `");
  });
});

describe("formatFencedCodeBlock", () => {
  it("keeps a three-backtick fence for short inner runs", () => {
    expect(formatFencedCodeBlock("a ``b`` c")).toBe("```\na ``b`` c\n```");
  });
});
