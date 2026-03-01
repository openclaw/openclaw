import { describe, expect, it } from "vitest";
import { resolveAutoThink, resolveAutoThinkingLevel } from "./auto-reasoning.js";

describe("resolveAutoThink", () => {
  it("resolves simple arithmetic to minimal", () => {
    expect(resolveAutoThink({ messageBody: "what is 2+2" })).toBe("minimal");
  });

  it("resolves short rewrite to low", () => {
    expect(resolveAutoThink({ messageBody: "Rewrite this sentence to be clearer." })).toBe("low");
  });

  it("resolves itinerary planning to medium or higher", () => {
    const result = resolveAutoThink({
      messageBody: "Plan a 7-day Italy itinerary with budget, transit, and food constraints.",
    });
    expect(["medium", "high", "xhigh"]).toContain(result);
  });

  it("resolves architecture and debugging prompts to high or xhigh", () => {
    const result = resolveAutoThink({
      messageBody:
        "Debug this production outage and propose architecture trade-offs and migration risks.",
    });
    expect(["high", "xhigh"]).toContain(result);
  });

  it("falls back to low for malformed input path", () => {
    expect(resolveAutoThink({ messageBody: undefined })).toBe("low");
  });

  it("avoids unsupported minimal on codex models", () => {
    expect(
      resolveAutoThink({
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        messageBody: "what is 2+2",
      }),
    ).toBe("low");
  });

  it("never returns off", () => {
    const prompts = [
      "what is 4+4",
      "summarize this paragraph",
      "compare these three options with constraints",
      "design a migration strategy for distributed DB failover",
      "",
    ];
    for (const prompt of prompts) {
      expect(resolveAutoThink({ messageBody: prompt })).not.toBe("off");
    }
  });
});

describe("resolveAutoThinkingLevel", () => {
  it("returns deterministic non-off level and metadata", async () => {
    const result = await resolveAutoThinkingLevel({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messageBody: "What is 2+2?",
    });
    expect(["minimal", "low", "medium", "high", "xhigh"]).toContain(result.thinkingLevel);
    expect(result.source).toBe("auto-meta");
    expect(result.selector.used).toBe(false);
  });
});
