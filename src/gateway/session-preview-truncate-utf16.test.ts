// UTF-16-safe truncation test for `text.slice(0, maxChars - 3)` in
// truncatePreviewText (src/gateway/session-utils.fs.ts:1928), which
// truncates session transcript message text for preview items.
// maxChars is caller-controlled (20-2000); this covers the boundary
// at 200 chars (a common preview limit).
import { describe, expect, it } from "vitest";
import { truncateUtf16Safe } from "../utils.js";

describe("session preview truncation", () => {
  it("drops the incomplete emoji pair instead of producing a lone surrogate (maxChars=200)", () => {
    // text = 196 't' + emoji + "xyz" = 201 code units (> 200, triggers
    // truncation). truncatePreviewText cuts at maxChars - 3 = 197.
    // emoji high surrogate at index 196 (inside the 197-char cut),
    // low surrogate at index 197 (outside). slice(0, 197) → lone
    // high surrogate. truncateUtf16Safe(197) backs out to 196.
    const text = "t".repeat(196) + "🚀xyz";
    expect(text.length).toBeGreaterThan(200);
    expect(text.slice(0, 197).charCodeAt(196)).toBe(0xd83d); // lone high surrogate
    const safe = truncateUtf16Safe(text, 197);
    expect(safe.length).toBe(196);
    expect(new TextDecoder().decode(new TextEncoder().encode(safe))).not.toContain("�");
  });

  it("preserves the complete emoji when it fits within the boundary", () => {
    // text = 195 't' + emoji = 197 code units. Both surrogate halves
    // are within the 197-char limit.
    const text = "t".repeat(195) + "🚀";
    expect(text.length).toBe(197);
    expect(truncateUtf16Safe(text, 197)).toBe(text);
  });

  it("preserves text shorter than the limit unchanged", () => {
    expect(truncateUtf16Safe("short preview", 197)).toBe("short preview");
    expect(truncateUtf16Safe("", 197)).toBe("");
  });
});
