import { describe, expect, it } from "vitest";
import {
  describeToolForVerbose,
  summarizeToolDescriptionText,
} from "./tool-description-summary.js";

function hasDanglingSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("tool description summaries", () => {
  it.each<[string | Parameters<typeof summarizeToolDescriptionText>[0], string]>([
    ["Search project docs.\nFurther details.", "Search project docs."],
    [
      "ACTIONS:\nEarlier detail.\n\nSecond paragraph summary.\nExtra detail.",
      "Second paragraph summary.",
    ],
    ["ACTIONS:\n- Query.\nFallback detail.\n\nJOB SCHEMA:\n{}\n[]", "Fallback detail."],
    ["ACTIONS:\n- Query.\n\nJOB SCHEMA:\n{}\n[]", "Tool"],
    ["Mixed Case Heading:\nLater detail.", "Mixed Case Heading:"],
    ["EXTENDED DETAILS:\nLater detail.", "Later detail."],
    ["Actions:\nAction detail.", "Action detail."],
    ["\n \n  Opening summary.  \n  Later line.  \n\nLast paragraph.", "Opening summary."],
    ["\ufeff\u00a0 First\tline\u2003 words\u2028tail\nOther", "First line words tail"],
    ["ACTIONS:\r\n- Query.\r\n\r\nCRLF summary.\r\nDetails.", "CRLF summary."],
    ["Alpha\rBeta", "Alpha Beta"],
    ["- ", "-"],
    ["* task", "* task"],
    [{}, "Tool"],
    [{ rawDescription: null }, "Tool"],
    ["\ufeff\u00a0 \t\n\u2003", "Tool"],
    [
      { rawDescription: "Ignored raw", displaySummary: "\u00a0 Preferred\t summary\u2003" },
      "Preferred summary",
    ],
    [{ rawDescription: "Raw fallback", displaySummary: " \t" }, "Raw fallback"],
    ["x".repeat(130), `${"x".repeat(117)}...`],
    [{ rawDescription: `${"a".repeat(50)} ${"b".repeat(80)}`, maxLen: 70 }, `${"a".repeat(50)}...`],
  ])("summarizes %j", (input, expected) => {
    expect(
      summarizeToolDescriptionText(typeof input === "string" ? { rawDescription: input } : input),
    ).toBe(expected);
  });

  it.each(["{ schema: true }", "[schema]", "- action"])(
    "excludes %j from paragraph summaries, fallback lines, and verbose descriptions",
    (excluded) => {
      expect(
        summarizeToolDescriptionText({
          rawDescription: `${excluded}\nEarlier detail.\n\nVisible summary.`,
        }),
      ).toBe("Visible summary.");
      expect(
        summarizeToolDescriptionText({
          rawDescription: `ACTIONS:\n${excluded}\nVisible fallback.`,
        }),
      ).toBe("Visible fallback.");
      expect(
        describeToolForVerbose({
          rawDescription: `Visible detail.\n${excluded}\nHidden detail.`,
          fallback: "Tool",
        }),
      ).toBe("Visible detail.");
    },
  );

  it("keeps compact summaries UTF-16 safe at truncation boundaries", () => {
    const summary = summarizeToolDescriptionText({
      displaySummary: "abcd😀 efgh",
      maxLen: 8,
    });

    expect(summary).toBe("abcd...");
    expect(hasDanglingSurrogate(summary)).toBe(false);
  });

  it("keeps verbose descriptions UTF-16 safe at truncation boundaries", () => {
    const description = describeToolForVerbose({
      rawDescription: `${"a".repeat(316)}😀 efgh`,
      fallback: "Tool",
    });

    expect(description).toBe(`${"a".repeat(316)}...`);
    expect(hasDanglingSurrogate(description)).toBe(false);
  });

  it.each<[string, string]>([
    [`${"a".repeat(316)}\n\ncd\nef`, `${"a".repeat(316)}\n\ncd`],
    [`${"a".repeat(316)}\n \n\t\ncd\nef`, `${"a".repeat(316)}\n\ncd`],
    [`  ${"a".repeat(316)}  \r\n\r\n  cd  \r\nef`, `${"a".repeat(316)}\n\ncd`],
    ["ab\n\nACTIONS:\nLater detail.", "ab"],
  ])("preserves verbose paragraph spacing and stopping for %j", (rawDescription, expected) => {
    expect(describeToolForVerbose({ rawDescription, fallback: "Tool" })).toBe(expected);
  });
});
