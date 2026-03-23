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

  it("keeps adjacent inline code outside fenced regions", () => {
    const text = ["```ts", "const a = 1;", "```", "after `inline` tail"].join("\n");

    const regions = findCodeRegions(text);

    expect(regions).toHaveLength(2);
    expect(text.slice(regions[0].start, regions[0].end)).toContain("```ts");
    expect(text.slice(regions[1].start, regions[1].end)).toBe("`inline`");
  });

  it("supports variable-length fences (4 or more backticks/tildes)", () => {
    const text = [
      "````xml",
      "<sample />",
      "````",
      "Outside.",
      "~~~~json",
      "{}",
      "~~~~",
      "End.",
    ].join("\n");

    const regions = findCodeRegions(text);

    expect(regions).toHaveLength(2);
    expect(text.slice(regions[0].start, regions[0].end)).toBe("````xml\n<sample />\n````\n");
    expect(text.slice(regions[1].start, regions[1].end)).toBe("~~~~json\n{}\n~~~~\n");

    const outsideIdx = text.indexOf("Outside.");
    expect(isInsideCode(outsideIdx, regions)).toBe(false);
  });

  it("reports whether positions are inside discovered regions", () => {
    const text = "plain `code` done";
    const regions = findCodeRegions(text);
    const codeStart = text.indexOf("code");
    const plainStart = text.indexOf("plain");
    const regionEnd = regions[0]?.end ?? -1;

    expect(isInsideCode(codeStart, regions)).toBe(true);
    expect(isInsideCode(plainStart, regions)).toBe(false);
    expect(isInsideCode(regionEnd, regions)).toBe(false);
  });
});
