import { describe, expect, it } from "vitest";
import {
  normalizeAuthChoiceInput,
  normalizeOnboardOptionsInput,
  normalizeOptionalString,
} from "./onboard-option-normalization.js";

describe("normalizeOptionalString", () => {
  it("trims strings and converts blank values to undefined", () => {
    expect(normalizeOptionalString("  abc  ")).toBe("abc");
    expect(normalizeOptionalString("   ")).toBeUndefined();
    expect(normalizeOptionalString(undefined)).toBeUndefined();
  });
});

describe("normalizeAuthChoiceInput", () => {
  it("treats blank auth choice as undefined", () => {
    expect(normalizeAuthChoiceInput("   ")).toBeUndefined();
    expect(normalizeAuthChoiceInput("openai-api-key")).toBe("openai-api-key");
  });
});

describe("normalizeOnboardOptionsInput", () => {
  it("normalizes auth-related optional strings", () => {
    const normalized = normalizeOnboardOptionsInput({
      authChoice: "  openrouter-api-key  ",
      tokenProvider: "  openrouter  ",
      token: "  sk-test  ",
      tokenProfileId: "  provider:manual  ",
      tokenExpiresIn: "  365d  ",
    });

    expect(normalized.authChoice).toBe("openrouter-api-key");
    expect(normalized.tokenProvider).toBe("openrouter");
    expect(normalized.token).toBe("sk-test");
    expect(normalized.tokenProfileId).toBe("provider:manual");
    expect(normalized.tokenExpiresIn).toBe("365d");
  });
});
