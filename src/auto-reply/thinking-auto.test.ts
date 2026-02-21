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

  it("defaults normal requests to medium", () => {
    const level = selectAdaptiveThinkingLevel({
      text: "What would a 3 day trip budget look like for 4 people?",
      supportsXHigh: true,
    });
    expect(level).toBe("medium");
  });

  it("uses low for lightweight conversational asks", () => {
    const level = selectAdaptiveThinkingLevel({
      text: "hey quick answer please",
      supportsXHigh: true,
    });
    expect(level).toBe("low");
  });
});
