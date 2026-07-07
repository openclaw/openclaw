import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// UTF-16-safe truncation tests for CLI table text helpers used by
// tasks, flows, commitments, and audit commands.
//
// Each command defines a private truncate(value, maxChars) function:
//   tasks.ts:        truncate(trimmed, maxChars), shortToken(_, 16), summary(_, 36), detail(_, 88)
//   flows.ts:        truncate(sanitized, maxChars), shortToken(_, 10), goal(_, 80), ctrl(_, 20)
//   commitments.ts:  truncate(safe(id), 16), scope(_, 28), suggestedText(_, 90)
//   audit.ts:        short(value, maxChars) — variant of the same pattern
//
// When value.length > maxChars, truncate calls truncateUtf16Safe(value, maxChars - 1).
// This test exercises the EXACT truncateUtf16Safe boundary that the private
// truncate function dispatches to, at the production maxChars values.
import { describe, expect, it } from "vitest";

describe("CLI text truncation", () => {
  it("drops the incomplete emoji pair instead of producing a lone surrogate (maxChars=16)", () => {
    // commitments.ts: truncate(id, 16) → truncateUtf16Safe(value, 15)
    // value = 14 x's + emoji + "zz" = 18 code units. emoji high surrogate at index 14.
    // slice(0, 15) includes the lone high surrogate → too much text, broken char.
    // truncateUtf16Safe(15) detects incomplete pair and backs out to 14 pure 'x'.
    const value = `${"x".repeat(14)}🚀zz`;
    expect(value.slice(0, 15).charCodeAt(14)).toBe(0xd83d); // lone high surrogate
    expect(truncateUtf16Safe(value, 15)).toBe("x".repeat(14)); // pair dropped cleanly
  });

  it("drops the incomplete emoji pair at the scope boundary (maxChars=28)", () => {
    // commitments.ts: truncate(scope, 28) → truncateUtf16Safe(value, 27)
    const value = `${"x".repeat(26)}🚀zzz`;
    expect(value.slice(0, 27).charCodeAt(26)).toBe(0xd83d);
    expect(truncateUtf16Safe(value, 27)).toBe("x".repeat(26));
  });

  it("drops the incomplete emoji pair at the detail boundary (maxChars=88)", () => {
    // tasks.ts: truncate(finding.detail, 88) → truncateUtf16Safe(value, 87)
    const value = `${"x".repeat(86)}🚀zzz`;
    expect(value.slice(0, 87).charCodeAt(86)).toBe(0xd83d);
    expect(truncateUtf16Safe(value, 87)).toBe("x".repeat(86));
  });

  it("drops the incomplete emoji pair at the suggestedText boundary (maxChars=90)", () => {
    // commitments.ts: truncate(suggestedText, 90) → truncateUtf16Safe(value, 89)
    const value = `${"x".repeat(88)}🚀zz`;
    expect(value.slice(0, 89).charCodeAt(88)).toBe(0xd83d);
    expect(truncateUtf16Safe(value, 89)).toBe("x".repeat(88));
  });

  it("drops the incomplete emoji pair at the shortToken boundary (maxChars=10)", () => {
    // flows.ts: shortToken(flowId, 10) → truncateUtf16Safe(value, 9)
    const value = "x".repeat(9) + "🚀";
    expect(value.slice(0, 10).charCodeAt(9)).toBe(0xd83d);
    expect(truncateUtf16Safe(value, 10)).toBe("x".repeat(9));
  });

  it("preserves text shorter than the limit unchanged", () => {
    expect(truncateUtf16Safe("short", 30)).toBe("short");
    expect(truncateUtf16Safe("", 30)).toBe("");
  });
});
