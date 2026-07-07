import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// UTF-16-safe truncation boundary tests for CLI table text helpers
// used by tasks, flows, commitments, and audit commands.
import { describe, expect, it } from "vitest";

describe("CLI text truncation", () => {
  it("does not split surrogate pairs at truncate(value, maxChars - 1) boundary", () => {
    // All four CLI commands (tasks, flows, commitments, audit) use variants of:
    //   truncate(value, maxChars) → `${value.slice(0, maxChars - 1)}…`
    //
    // "🚀" is a surrogate pair (2 UTF-16 code units). A value with 29 'w' + the
    // emoji has 31 code units. With maxChars=30, the old code calls slice(0, 29),
    // which is safe here (29 whole 'w' characters), but at maxChars=31 the emoji
    // straddles the cut. truncateUtf16Safe handles both cases correctly.
    const value = "w".repeat(29) + "🚀";

    // At maxChars=31: slice(0, 30) splits between high/low surrogate
    const sliced = value.slice(0, 30);
    expect(sliced.charCodeAt(29)).toBe(0xd83d); // lone high surrogate
    // truncateUtf16Safe at 30 backs out past the incomplete pair
    expect(truncateUtf16Safe(value, 30)).toBe("w".repeat(29));

    // At maxChars=30: slice(0, 29) is safe (29 whole 'w'), but
    // truncateUtf16Safe is still correct — no regression
    expect(truncateUtf16Safe(value, 29)).toBe("w".repeat(29));
  });

  it("preserves text shorter than the limit unchanged", () => {
    expect(truncateUtf16Safe("short task name", 30)).toBe("short task name");
    expect(truncateUtf16Safe("", 30)).toBe("");
  });
});
