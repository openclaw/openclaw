import { describe, expect, it } from "vitest";
import { selectAdaptiveThinkingLevel } from "./thinking-auto.js";

describe("selectAdaptiveThinkingLevel", () => {
  it("selects xhigh for architecture/planning prompts when supported", () => {
    const level = selectAdaptiveThinkingLevel({
      text: "Can you create a system design and migration plan for this architecture?",
      supportsXHigh: true,
    });
    expect(level).toBe("xhigh");
  });

  it("falls back to high when xhigh is not supported", () => {
    const level = selectAdaptiveThinkingLevel({
      text: "Need an architectural RFC with trade-offs",
      supportsXHigh: false,
    });
    expect(level).toBe("high");
  });

  it("returns medium for common task-style prompts", () => {
    const level = selectAdaptiveThinkingLevel({
      text: "What would a 3 day trip budget look like for 4 people?",
      supportsXHigh: true,
    });
    expect(level).toBe("medium");
  });

  it("uses low for lightweight conversational asks", () => {
    const level = selectAdaptiveThinkingLevel({
      text: "quick answer please",
      supportsXHigh: true,
    });
    expect(level).toBe("low");
  });

  it("does not downgrade substantive prompts just because they start with a greeting", () => {
    const level = selectAdaptiveThinkingLevel({
      text: "hey can you summarize this document in 5 bullets",
      supportsXHigh: true,
    });
    expect(level).toBe("medium");
  });

  it("returns undefined for low-confidence prompts and lets defaults handle them", () => {
    const level = selectAdaptiveThinkingLevel({
      text: "Can you take a look at this?",
      supportsXHigh: true,
    });
    expect(level).toBeUndefined();
  });
});
