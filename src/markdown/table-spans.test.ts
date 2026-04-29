import { describe, expect, it } from "vitest";
import { findTableSpanAt, isSafeTableBreak, parseTableSpans } from "./table-spans.js";

describe("Markdown table spans", () => {
  it("finds pipe table spans and safe boundaries around them", () => {
    const text = [
      "Intro",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Alpha | One |",
      "| Beta | Two |",
      "",
      "Outro",
    ].join("\n");

    const spans = parseTableSpans(text);

    expect(spans).toEqual([{ start: 7, end: 68 }]);
    expect(findTableSpanAt(spans, text.indexOf("| Alpha"))).toEqual(spans[0]);
    expect(isSafeTableBreak(spans, spans[0]?.start ?? 0)).toBe(true);
    expect(isSafeTableBreak(spans, text.indexOf("| Beta"))).toBe(false);
    expect(isSafeTableBreak(spans, spans[0]?.end ?? 0)).toBe(true);
  });

  it("supports tables without leading edge pipes", () => {
    const text = "A | B\n--- | ---\n1 | 2";

    expect(parseTableSpans(text)).toEqual([{ start: 0, end: text.length }]);
  });
});
