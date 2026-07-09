// Model list formatting tests cover fixed-width terminal cell helpers.
import { describe, expect, it } from "vitest";
import { truncate } from "./list.format.js";

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codeUnit = value.charCodeAt(i);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      const previous = value.charCodeAt(i - 1);
      if (!(previous >= 0xd800 && previous <= 0xdbff)) {
        return true;
      }
    }
  }
  return false;
}

describe("truncate", () => {
  it("preserves existing ASCII truncation with an ellipsis suffix", () => {
    expect(truncate("abcdefghi", 6)).toBe("abc...");
  });

  it("keeps ellipsis-suffixed truncation on a UTF-16 boundary", () => {
    const grin = String.fromCodePoint(0x1f600);
    const result = truncate(`ab${grin}cde`, 6);

    expect(result).toBe("ab...");
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it("keeps tiny truncation budgets on a UTF-16 boundary", () => {
    const grin = String.fromCodePoint(0x1f600);
    const result = truncate(grin, 1);

    expect(result).toBe("");
    expect(hasLoneSurrogate(result)).toBe(false);
  });
});
