// Assistant identity tests cover normalized assistant names and metadata values.
import { describe, expect, it } from "vitest";
import { coerceIdentityValue } from "./assistant-identity-values.js";

describe("shared/assistant-identity-values", () => {
  it("returns undefined for missing or blank values", () => {
    expect(coerceIdentityValue(undefined, 10)).toBeUndefined();
    expect(coerceIdentityValue("   ", 10)).toBeUndefined();
    expect(coerceIdentityValue(42 as unknown as string, 10)).toBeUndefined();
  });

  it("trims values and preserves strings within the limit", () => {
    expect(coerceIdentityValue("  OpenClaw  ", 20)).toBe("OpenClaw");
    expect(coerceIdentityValue("  OpenClaw  ", 8)).toBe("OpenClaw");
  });

  it("truncates overlong trimmed values at the exact limit", () => {
    expect(coerceIdentityValue("  OpenClaw Assistant  ", 8)).toBe("OpenClaw");
  });

  it("returns an empty string when truncating to a zero-length limit", () => {
    expect(coerceIdentityValue("  OpenClaw  ", 0)).toBe("");
    // truncateUtf16Safe returns empty string for negative limits
    expect(coerceIdentityValue("  OpenClaw  ", -1)).toBe("");
  });

  it("handles emoji surrogate pairs safely at truncation boundary", () => {
    // Emoji at the truncation boundary should not produce lone surrogates
    // 🚀 is a surrogate pair (2 UTF-16 code units)
    const textWithEmoji = "x".repeat(9) + "🚀" + "yz"; // emoji at position 10-11 (UTF-16 indices)

    // truncateUtf16Safe safely handles emoji boundaries:
    // - At limit 10: drops the emoji (would be lone surrogate)
    // - At limit 11: includes the full emoji (both surrogates fit)
    expect(coerceIdentityValue(textWithEmoji, 10)).toBe("xxxxxxxxx");
    expect(coerceIdentityValue(textWithEmoji, 11)).toBe("xxxxxxxxx🚀");
    expect(coerceIdentityValue(textWithEmoji, 12)).toBe("xxxxxxxxx🚀y");

    // Verify no lone surrogates in any result
    for (const limit of [5, 10, 11, 12, 15]) {
      const result = coerceIdentityValue(textWithEmoji, limit)!;
      expect([...result].every((c) => !(c >= "\uDC00" && c <= "\uDFFF"))).toBe(true);
    }
  });
});
