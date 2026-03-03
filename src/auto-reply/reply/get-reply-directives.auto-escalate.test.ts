import { describe, expect, it } from "vitest";
import { shouldAutoEscalateToQwen7b } from "./get-reply-directives.js";

describe("shouldAutoEscalateToQwen7b", () => {
  it("returns false for short simple chat", () => {
    expect(shouldAutoEscalateToQwen7b("hey")).toBe(false);
    expect(shouldAutoEscalateToQwen7b("thanks")).toBe(false);
  });

  it("returns true for ULTRON and trading prompts", () => {
    expect(shouldAutoEscalateToQwen7b("use ultron skill to assess nvda today")).toBe(true);
    expect(shouldAutoEscalateToQwen7b("pre-market setup for TSLA")).toBe(true);
  });

  it("returns true for ticker-like patterns", () => {
    expect(shouldAutoEscalateToQwen7b("analyze $NVDA now")).toBe(true);
    expect(shouldAutoEscalateToQwen7b("ticker: aapl technical analysis")).toBe(true);
  });
});
