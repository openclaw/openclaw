import { describe, expect, it } from "vitest";
import { findCodeRegions, isInsideCode } from "./code-regions.js";

describe("shared/text/code-regions", () => {
  it("finds fenced and inline code regions without double-counting inline code inside fences", () => {
    const text = [
      "before `inline` after",
      "```ts",
      "const a = `inside fence`;",
      "```",
      "tail",
    ].join("\n");

    const regions = findCodeRegions(text);

    expect(regions).toHaveLength(2);
    expect(text.slice(regions[0].start, regions[0].end)).toBe("`inline`");
    expect(text.slice(regions[1].start, regions[1].end)).toContain("```ts");
  });

  it("accepts alternate fence markers and unterminated trailing fences", () => {
    const text = "~~~js\nconsole.log(1)\n~~~\nplain\n```\nunterminated";
    const regions = findCodeRegions(text);

    expect(regions).toHaveLength(2);
    expect(text.slice(regions[0].start, regions[0].end)).toContain("~~~js");
    expect(text.slice(regions[1].start, regions[1].end)).toBe("```\nunterminated");
  });

  it("reports whether positions are inside discovered regions", () => {
    const text = "plain `code` done";
    const regions = findCodeRegions(text);
    const codeStart = text.indexOf("code");
    const plainStart = text.indexOf("plain");

    expect(isInsideCode(codeStart, regions)).toBe(true);
    expect(isInsideCode(plainStart, regions)).toBe(false);
  });
});
