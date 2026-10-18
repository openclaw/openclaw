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
});

describe("formatFencedCodeBlock", () => {
  it("keeps a three-backtick fence for short inner runs", () => {
    expect(formatFencedCodeBlock("a ``b`` c")).toBe("```\na ``b`` c\n```");
  });
});
