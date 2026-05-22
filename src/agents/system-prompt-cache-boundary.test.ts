import { describe, expect, it } from "vitest";
import {
  appendSystemPromptAdditionAfterCacheBoundary,
  ensureSystemPromptCacheBoundary,
  prependSystemPromptAdditionAfterCacheBoundary,
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "./system-prompt-cache-boundary.js";

describe("system prompt cache boundary helpers", () => {
  it("splits stable and dynamic prompt regions", () => {
    expect(
      splitSystemPromptCacheBoundary(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`),
    ).toEqual({
      stablePrefix: "Stable prefix",
      dynamicSuffix: "Dynamic suffix",
    });
  });

  it("strips the internal marker from prompt text", () => {
    expect(
      stripSystemPromptCacheBoundary(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`),
    ).toBe("Stable prefix\nDynamic suffix");
  });

  it("inserts prompt additions after the cache boundary", () => {
    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        systemPromptAddition: "Per-turn lab context",
      }),
    ).toBe(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Per-turn lab context\n\nDynamic suffix`);
  });

  it("normalizes structured additions and dynamic suffix whitespace", () => {
    expect(
      prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix  \r\n\r\nMore detail \t\r\n`,
        systemPromptAddition: "  Per-turn lab context \r\nSecond line\t\r\n",
      }),
    ).toBe(
      `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Per-turn lab context\nSecond line\n\nDynamic suffix\n\nMore detail`,
    );
  });

  describe("ensureSystemPromptCacheBoundary", () => {
    it("returns prompts that already contain the marker unchanged", () => {
      const prompt = `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`;
      expect(ensureSystemPromptCacheBoundary(prompt)).toBe(prompt);
    });

    it("returns nested-marker prompts unchanged so split can find the structural first marker", () => {
      const prompt = `A${SYSTEM_PROMPT_CACHE_BOUNDARY}B${SYSTEM_PROMPT_CACHE_BOUNDARY}C`;
      expect(ensureSystemPromptCacheBoundary(prompt)).toBe(prompt);
    });

    it("appends a synthesized marker when the base lacks one", () => {
      expect(ensureSystemPromptCacheBoundary("base prompt")).toBe(
        `base prompt${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
      );
    });

    it("trims trailing whitespace before synthesizing the marker", () => {
      expect(ensureSystemPromptCacheBoundary("base prompt   \n  ")).toBe(
        `base prompt${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
      );
    });

    it("returns just the marker for empty or whitespace-only bases", () => {
      expect(ensureSystemPromptCacheBoundary("")).toBe(SYSTEM_PROMPT_CACHE_BOUNDARY);
      expect(ensureSystemPromptCacheBoundary("   \n   ")).toBe(SYSTEM_PROMPT_CACHE_BOUNDARY);
    });
  });

  describe("appendSystemPromptAdditionAfterCacheBoundary", () => {
    it("places the addition after the existing dynamic suffix when the marker is present", () => {
      expect(
        appendSystemPromptAdditionAfterCacheBoundary({
          systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
          systemPromptAddition: "Runtime context",
        }),
      ).toBe(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix\n\nRuntime context`);
    });

    it("places the addition immediately after the marker when dynamic suffix is empty", () => {
      expect(
        appendSystemPromptAdditionAfterCacheBoundary({
          systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
          systemPromptAddition: "Runtime context",
        }),
      ).toBe(`Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Runtime context`);
    });

    it("appends to the end (non-injecting) when the marker is absent", () => {
      expect(
        appendSystemPromptAdditionAfterCacheBoundary({
          systemPrompt: "base without marker",
          systemPromptAddition: "Runtime context",
        }),
      ).toBe("base without marker\n\nRuntime context");
    });

    it("returns the original prompt unchanged when the addition normalizes to empty", () => {
      const prompt = `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`;
      expect(
        appendSystemPromptAdditionAfterCacheBoundary({
          systemPrompt: prompt,
          systemPromptAddition: "   \r\n  ",
        }),
      ).toBe(prompt);
      expect(
        appendSystemPromptAdditionAfterCacheBoundary({
          systemPrompt: prompt,
          systemPromptAddition: undefined,
        }),
      ).toBe(prompt);
    });

    it("normalizes structured addition whitespace and line endings", () => {
      expect(
        appendSystemPromptAdditionAfterCacheBoundary({
          systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
          systemPromptAddition: "  runtime line  \r\nsecond line\t\r\n",
        }),
      ).toBe(`Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic\n\nruntime line\nsecond line`);
    });
  });

  describe("marker-bearing addition sanitization", () => {
    it("strips full markers smuggled into prepend additions", () => {
      const result = prependSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
        systemPromptAddition: `before ${SYSTEM_PROMPT_CACHE_BOUNDARY}after`,
      });
      const markerCount = result.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1;
      expect(markerCount).toBe(1);
      expect(stripSystemPromptCacheBoundary(result)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    });

    it("strips trimmed comment substrings smuggled into append additions even without surrounding newlines", () => {
      const result = appendSystemPromptAdditionAfterCacheBoundary({
        systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
        systemPromptAddition: "embed <!-- OPENCLAW_CACHE_BOUNDARY --> inline",
      });
      const markerCount = result.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1;
      expect(markerCount).toBe(1);
      expect(stripSystemPromptCacheBoundary(result)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    });
  });
});
