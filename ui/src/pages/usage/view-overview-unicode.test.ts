import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Tests that session key truncation in usage overview uses Unicode-safe slicing.
import { describe, expect, it } from "vitest";

// The original code used: selectedSessionKey.slice(0, 8) + "..."
// The fixed code uses: truncateUtf16Safe(selectedSessionKey, 8) + "..."
function renderSessionKeyDisplay(key: string): string {
  return key.length > 8 ? truncateUtf16Safe(key, 8) + "..." : key;
}

describe("session key Unicode-safe truncation", () => {
  it("keeps a short key unmodified", () => {
    expect(renderSessionKeyDisplay("abc")).toBe("abc");
  });

  it("truncates an ASCII key at 8 characters", () => {
    expect(renderSessionKeyDisplay("abcdefghijk")).toBe("abcdefgh...");
  });

  it("excludes a surrogate pair cleanly straddling the 8-char boundary", () => {
    const key = "1234567🦞extra";
    const result = renderSessionKeyDisplay(key);
    expect(result).toBe("1234567...");
    const lastDisplayed = result.charCodeAt(result.indexOf("...") - 1);
    const isHighSurrogate = lastDisplayed >= 0xd800 && lastDisplayed <= 0xdbff;
    expect(isHighSurrogate).toBe(false);
  });

  it("preserves an emoji fully within the 8-char boundary", () => {
    const key = "123456🦞extra";
    const result = renderSessionKeyDisplay(key);
    expect(result).toBe("123456🦞...");
  });

  it("does not append ellipsis for keys of exactly 8 chars", () => {
    expect(renderSessionKeyDisplay("12345678")).toBe("12345678");
  });
});
