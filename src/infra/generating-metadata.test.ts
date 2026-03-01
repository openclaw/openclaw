import { describe, expect, it } from "vitest";
import { buildGeneratingMetadata } from "./generating-metadata.js";

describe("buildGeneratingMetadata", () => {
  it("includes chosen thinking level on run start metadata", () => {
    const meta = buildGeneratingMetadata({
      thinkingLevel: "medium",
      reasoningLevel: "off",
      source: "inline-directive",
      autoReasoningEnabled: false,
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(meta.thinkingLevel).toBe("medium");
    expect(meta.reasoningLevel).toBe("off");
    expect(meta.source).toBe("inline-directive");
    expect(meta.autoReasoningEnabled).toBe(false);
    expect(meta.availableThinkingLevels).toContain("medium");
  });

  it("reflects effective level when xhigh degrades to high", () => {
    const meta = buildGeneratingMetadata({
      thinkingLevel: "xhigh",
      reasoningLevel: "off",
      source: "session-directive",
      effectiveThinkingLevel: "high",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    expect(meta.thinkingLevel).toBe("high");
    expect(meta.source).toBe("session-directive");
  });

  it("includes selector info when fallback used", () => {
    const meta = buildGeneratingMetadata({
      thinkingLevel: "low",
      reasoningLevel: "off",
      source: "auto-fallback",
      autoReasoningEnabled: true,
      provider: "anthropic",
      model: "claude-opus-4-6",
      selector: {
        used: true,
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      selectorFallbackUsed: true,
      selectorTimedOut: true,
    });
    expect(meta.selector?.fallbackUsed).toBe(true);
    expect(meta.selector?.timedOut).toBe(true);
    expect(meta.autoReasoningEnabled).toBe(true);
  });
});
