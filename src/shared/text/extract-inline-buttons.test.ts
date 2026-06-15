import { describe, expect, it } from "vitest";
import { extractInlineButtons } from "./extract-inline-buttons.js";

describe("extractInlineButtons", () => {
  it("extracts single button row from text", () => {
    const input = `Here is a report.\n\n[[[{"text":"Approve","callback_data":"approve_1"}]]]`;
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]).toHaveLength(1);
    expect(result.buttons[0][0].text).toBe("Approve");
    expect(result.buttons[0][0].callback_data).toBe("approve_1");
    expect(result.text).not.toContain("[[");
    expect(result.text).toContain("Here is a report");
  });

  it("extracts multiple buttons in a row", () => {
    const input = `Choose:\n[[[{"text":"Yes","callback_data":"yes"},{"text":"No","callback_data":"no"}]]]`;
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]).toHaveLength(2);
    expect(result.buttons[0][0].text).toBe("Yes");
    expect(result.buttons[0][1].text).toBe("No");
  });

  it("returns empty buttons when no inline button pattern found", () => {
    const input = "Just some regular text with no buttons.";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe(input);
  });

  it("ignores non-JSON bracket content", () => {
    const input = "Use [[tts:voice]] and [[reply_to_current]] directives.";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe(input);
  });

  it("ignores bracket content that is not valid button JSON", () => {
    const input = `[[["not","valid","buttons"]]] is ignored.`;
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe(input);
  });

  it("cleans up whitespace after removal", () => {
    const input = `Text before\n\n[[[{"text":"Click","callback_data":"click"}]]]\n\nText after`;
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.text).toContain("Text before");
    expect(result.text).toContain("Text after");
    expect(result.text).not.toContain("[[");
  });

  it("handles empty input", () => {
    const result = extractInlineButtons("");
    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe("");
  });

  it("handles multi-row button format", () => {
    // Multi-row wraps each row inside an outer JSON array: [[row1],[row2]]
    const input =
      "Options:\n[[[[{\"text\":\"Row1\",\"callback_data\":\"r1\"}],[{\"text\":\"Row2\",\"callback_data\":\"r2\"}]]]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(2);
    expect(result.buttons[0]).toHaveLength(1);
    expect(result.buttons[0][0].text).toBe("Row1");
    expect(result.buttons[1]).toHaveLength(1);
    expect(result.buttons[1][0].text).toBe("Row2");
    expect(result.text).not.toContain("[[");
    expect(result.text).toContain("Options:");
  });

  it("handles nested JSON structures inside buttons correctly", () => {
    const input =
      "Pick:\n[[[{\"text\":\"Click\",\"callback_data\":\"click\"},{\"text\":\"More\",\"callback_data\":\"more\"}]]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]).toHaveLength(2);
    expect(result.buttons[0][0].text).toBe("Click");
    expect(result.buttons[0][1].text).toBe("More");
  });

  it("handles multiple inline button blocks in the same text", () => {
    const input =
      "First:\n[[[{\"text\":\"A\",\"callback_data\":\"a\"}]]]\nSecond:\n[[[{\"text\":\"B\",\"callback_data\":\"b\"}]]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(2);
    expect(result.buttons[0][0].text).toBe("A");
    expect(result.buttons[1][0].text).toBe("B");
    expect(result.text).toContain("First:");
    expect(result.text).toContain("Second:");
    expect(result.text).not.toContain("[[");
  });

  it("ignores nested [[brackets]] that are not button JSON", () => {
    const input =
      "Use the [[reply_to_current]] tag and [[tts:voice]] directive but not [invalid JSON]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe(input);
  });
});
