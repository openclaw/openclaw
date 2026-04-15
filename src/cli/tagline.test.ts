import { describe, expect, it } from "vitest";
import { DEFAULT_TAGLINE, TAGLINES, pickTagline } from "./tagline.js";

describe("pickTagline", () => {
  it("returns empty string when mode is off", () => {
    expect(pickTagline({ mode: "off" })).toBe("");
  });

  it("returns default tagline when mode is default", () => {
    expect(pickTagline({ mode: "default" })).toBe(DEFAULT_TAGLINE);
  });

  it("keeps OPENCLAW_TAGLINE_INDEX behavior in random mode", () => {
    const value = pickTagline({
      mode: "random",
      env: { OPENCLAW_TAGLINE_INDEX: "0" } as NodeJS.ProcessEnv,
    });
    expect(value.length).toBeGreaterThan(0);
    expect(value).not.toBe(DEFAULT_TAGLINE);
  });

  it("keeps random taglines neutral and operator-facing", () => {
    const bannedTerms = [
      "segfault",
      "roast",
      "judge",
      "dignity",
      "spite",
      "passive-aggressive",
      "possessed",
      "relationships",
      "shame",
    ];

    for (const tagline of TAGLINES) {
      const lower = tagline.toLowerCase();
      for (const term of bannedTerms) {
        expect(lower).not.toContain(term);
      }
    }
  });
});
