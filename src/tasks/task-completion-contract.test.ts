// Task completion contract tests.
import { expect, describe, it } from "vitest";
import { truncateUtf16Safe } from "../utils.js";

describe("normalizeCompletionFailureReason truncation", () => {
  it("does not cut failure reason with an emoji straddling the 159-char boundary", () => {
    // "🚀" is a surrogate pair (2 UTF-16 code units). A failure reason with
    // 158 'z' + the emoji has 160 code units. slice(0,159) splits the pair;
    // truncateUtf16Safe backs out to 158 code points.
    const text = "z".repeat(158) + "🚀";
    // slice splits the surrogate pair at position 159
    const sliced = text.slice(0, 159);
    expect(sliced.charCodeAt(158)).toBe(0xd83d); // lone high surrogate
    // truncateUtf16Safe drops the incomplete pair
    expect(truncateUtf16Safe(text, 159)).toBe("z".repeat(158));
  });

  it("preserves failure reason text shorter than the limit unchanged", () => {
    expect(truncateUtf16Safe("task blocked: no provider", 159)).toBe("task blocked: no provider");
    expect(truncateUtf16Safe("", 159)).toBe("");
  });

  it("truncates long failure reasons without broken surrogates", () => {
    const long = "a".repeat(200);
    const result = truncateUtf16Safe(long, 159);
    expect(result).toBe("a".repeat(159));
    expect(result.length).toBe(159);
  });
});
