// UTF-16-safe truncation boundary tests for onboarding CLI text helpers.
import { describe, expect, it } from "vitest";
import { truncateUtf16Safe } from "../utils.js";

describe("onboarding text truncation", () => {
  it("does not split surrogate pairs at the plugin error boundary (179)", () => {
    // onboarding-plugin-install.ts: slice(0, 179) → truncateUtf16Safe(v, 179)
    const text = "w".repeat(178) + "🚀";
    const sliced = text.slice(0, 179);
    expect(sliced.charCodeAt(178)).toBe(0xd83d); // lone high surrogate
    expect(truncateUtf16Safe(text, 179)).toBe("w".repeat(178));
  });

  it("does not split surrogate pairs at the error summary boundary (119)", () => {
    // onboard-helpers.ts: slice(0, 119) → truncateUtf16Safe(v, 119)
    const text = "e".repeat(118) + "🚀";
    const sliced = text.slice(0, 119);
    expect(sliced.charCodeAt(118)).toBe(0xd83d);
    expect(truncateUtf16Safe(text, 119)).toBe("e".repeat(118));
  });

  it("does not split surrogate pairs at the skill summary boundary (139)", () => {
    // onboard-skills.ts: slice(0, maxLen - 1) with maxLen=140
    const text = "s".repeat(138) + "🚀";
    const sliced = text.slice(0, 139);
    expect(sliced.charCodeAt(138)).toBe(0xd83d);
    expect(truncateUtf16Safe(text, 139)).toBe("s".repeat(138));
  });

  it("does not split surrogate pairs at the skill hint boundary (89)", () => {
    // onboard-skills.ts: slice(0, maxLen - 1) with maxLen=90
    const text = "h".repeat(88) + "🚀";
    const sliced = text.slice(0, 89);
    expect(sliced.charCodeAt(88)).toBe(0xd83d);
    expect(truncateUtf16Safe(text, 89)).toBe("h".repeat(88));
  });

  it("preserves short text unchanged", () => {
    expect(truncateUtf16Safe("short", 90)).toBe("short");
    expect(truncateUtf16Safe("", 90)).toBe("");
  });
});
