import { describe, expect, it } from "vitest";
import { formatFencedCodeBlock, formatInlineCodeSpan } from "./markdown-code.js";

describe("formatInlineCodeSpan", () => {
  it("wraps plain text in single backticks without padding", () => {
    expect(formatInlineCodeSpan("echo hi")).toBe("`echo hi`");
  });

  it("grows the delimiter past embedded backtick runs", () => {
    expect(formatInlineCodeSpan("a `b` c")).toBe("``a `b` c``");
    expect(formatInlineCodeSpan("x ``y`` z")).toBe("```x ``y`` z```");
  });

  it("pads when content starts or ends with a backtick", () => {
    expect(formatInlineCodeSpan("`edge")).toBe("`` `edge ``");
    expect(formatInlineCodeSpan("edge`")).toBe("`` edge` ``");
  });

  it("pads multi-line content", () => {
    expect(formatInlineCodeSpan("a\nb")).toBe("` a\nb `");
  });

  it("guards edge spaces against CommonMark one-space stripping", () => {
    expect(formatInlineCodeSpan(" 1 ")).toBe("`  1  `");
    expect(formatInlineCodeSpan(" `code` ")).toBe("``  `code`  ``");
  });

  it("guards edge spaces held apart by a tab or a non-ASCII space", () => {
    // The renderer's all-spaces exception is U+0020 only, so a tab or a
    // no-break space inside makes both edge spaces strippable.
    expect(formatInlineCodeSpan(" \t ")).toBe("`  \t  `");
    expect(formatInlineCodeSpan(" a\tb ")).toBe("`  a\tb  `");
    expect(formatInlineCodeSpan(" \u00a0 ")).toBe("`  \u00a0  `");
  });

  it("does not pad content whose spaces are safe", () => {
    expect(formatInlineCodeSpan(" leading")).toBe("` leading`");
    expect(formatInlineCodeSpan("trailing ")).toBe("`trailing `");
    expect(formatInlineCodeSpan("   ")).toBe("`   `");
  });

  it("keeps edge-backtick padding correct when the far edge has a space", () => {
    expect(formatInlineCodeSpan("`x ")).toBe("`` `x  ``");
  });
});

describe("formatFencedCodeBlock", () => {
  it("uses a three-backtick fence for plain text", () => {
    expect(formatFencedCodeBlock("hello")).toBe("```\nhello\n```");
  });

  it("appends the language to the opening fence", () => {
    expect(formatFencedCodeBlock("ls", "sh")).toBe("```sh\nls\n```");
  });

  it("grows the fence past embedded triple backticks", () => {
    expect(formatFencedCodeBlock("```js\ncode\n```")).toBe("````\n```js\ncode\n```\n````");
  });

  it("keeps a three-backtick fence for short inner runs", () => {
    expect(formatFencedCodeBlock("a ``b`` c")).toBe("```\na ``b`` c\n```");
  });
});
