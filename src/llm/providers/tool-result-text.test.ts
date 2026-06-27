// Tool-result text extraction keeps provider conversion lossless; established
// context/tool-result guards own payload budgeting and truncation later.
import { describe, expect, it } from "vitest";
import { extractToolResultText } from "./tool-result-text.js";

describe("extractToolResultText", () => {
  it("does not truncate structured blocks at the provider helper boundary", () => {
    const tail = "tail-marker";
    const text = extractToolResultText([
      {
        type: "json",
        data: {
          payload: `${"x".repeat(1_200)}${tail}`,
        },
      },
    ]);

    expect(text).toContain(tail);
    expect(text).not.toContain("... (");
  });
});
