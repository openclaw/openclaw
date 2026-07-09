// Covers live chat buffer capping including surrogate-safe tail truncation.
import { describe, expect, it } from "vitest";
import { capLiveAssistantBuffer } from "./live-chat-projector.js";

describe("capLiveAssistantBuffer", () => {
  it("returns the original text when it fits within the buffer cap", () => {
    expect(capLiveAssistantBuffer("short text")).toBe("short text");
  });

  it("keeps only the tail when text exceeds the cap", () => {
    const input = `${"x".repeat(100)}tail`;
    const result = capLiveAssistantBuffer(input);
    expect(result).toContain("tail");
    expect(result.length).toBeLessThan(input.length);
  });

  it("does not split a surrogate pair at the tail boundary", () => {
    // emoji (2 code units) at the boundary of the cap
    const result = capLiveAssistantBuffer(`🚀${"y".repeat(500_001)}`);
    expect(result).not.toContain("�");
  });

  it("returns the full text when at the exact cap size", () => {
    // cap is 500_000 chars; text shorter than cap
    const input = "hello";
    const result = capLiveAssistantBuffer(input);
    expect(result).toBe("hello");
  });
});
