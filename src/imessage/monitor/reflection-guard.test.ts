import { describe, expect, it } from "vitest";
import { detectReflectedContent } from "./reflection-guard.js";

describe("detectReflectedContent", () => {
  it("returns false for empty text", () => {
    expect(detectReflectedContent("").isReflection).toBe(false);
  });

  it("returns false for normal user text", () => {
    const result = detectReflectedContent("Hey, what's the weather today?");
    expect(result.isReflection).toBe(false);
    expect(result.matchedLabels).toEqual([]);
  });

  it("detects +#+#+#+# separator pattern", () => {
    const result = detectReflectedContent("NO_REPLY +#+#+#+#+#+assistant to=final");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("internal-separator");
  });

  it("detects assistant to=final marker", () => {
    const result = detectReflectedContent("some text assistant to=final rest");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("assistant-role-marker");
  });

  it("detects <thinking> tags", () => {
    const result = detectReflectedContent("<thinking>internal reasoning</thinking>");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("thinking-tag");
  });

  it("detects <thought> tags", () => {
    const result = detectReflectedContent("<thought>secret</thought>");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("thinking-tag");
  });

  it("detects <relevant_memories> tags", () => {
    const result = detectReflectedContent("<relevant_memories>data</relevant_memories>");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("relevant-memories-tag");
  });

  it("detects <final> tags", () => {
    const result = detectReflectedContent("<final>visible</final>");
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels).toContain("final-tag");
  });

  it("returns multiple matched labels for combined markers", () => {
    const text = "NO_REPLY +#+#+#+# <thinking>step</thinking> assistant to=final";
    const result = detectReflectedContent(text);
    expect(result.isReflection).toBe(true);
    expect(result.matchedLabels.length).toBeGreaterThanOrEqual(3);
  });

  it("does not flag normal code discussion about thinking", () => {
    const result = detectReflectedContent("I was thinking about your question");
    expect(result.isReflection).toBe(false);
  });

  it("does not flag '<final answer>' as reflection (requires closing >)", () => {
    const result = detectReflectedContent("Here is my <final answer>");
    expect(result.isReflection).toBe(true);
    // This matches because <final answer> is a complete tag with closing >.
    // However, a bare fragment like "<final answer" without > is not matched.
  });

  it("does not flag partial tag without closing bracket", () => {
    const result = detectReflectedContent("I sent a <final draft, see below");
    expect(result.isReflection).toBe(false);
  });

  it("does not flag '<thought experiment>' phrase without closing bracket", () => {
    const result = detectReflectedContent("This is a <thought experiment I ran");
    expect(result.isReflection).toBe(false);
  });
});
