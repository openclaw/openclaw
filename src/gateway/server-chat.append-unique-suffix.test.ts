import { describe, expect, it } from "vitest";
import { appendUniqueSuffix } from "./server-chat.js";

describe("appendUniqueSuffix", () => {
  it("returns suffix when base is empty", () => {
    expect(appendUniqueSuffix("", "hello")).toBe("hello");
  });

  it("returns base when suffix is empty", () => {
    expect(appendUniqueSuffix("hello", "")).toBe("hello");
  });

  it("concatenates non-overlapping text", () => {
    expect(appendUniqueSuffix("hello", " world")).toBe("hello world");
  });

  // ---- Regression tests for #43828: repeated characters ----

  it("does not deduplicate single repeated char", () => {
    expect(appendUniqueSuffix("9", "9")).toBe("99");
  });

  it("does not deduplicate multi-char repeated suffix", () => {
    expect(appendUniqueSuffix("99", "99")).toBe("9999");
  });

  it("handles streaming repeated single-char deltas", () => {
    // Simulate streaming "999999" one token at a time
    let accumulated = "9";
    for (let i = 0; i < 5; i++) {
      accumulated = appendUniqueSuffix(accumulated, "9");
    }
    expect(accumulated).toBe("999999");
  });

  it("handles streaming repeated multi-char deltas", () => {
    let accumulated = "ha";
    accumulated = appendUniqueSuffix(accumulated, "ha");
    accumulated = appendUniqueSuffix(accumulated, "ha");
    expect(accumulated).toBe("hahaha");
  });

  it("handles streaming repeated word tokens", () => {
    let accumulated = "the ";
    accumulated = appendUniqueSuffix(accumulated, "the ");
    accumulated = appendUniqueSuffix(accumulated, "the ");
    expect(accumulated).toBe("the the the ");
  });

  it("concatenates segment boundaries correctly", () => {
    // Simulates text segments after tool calls
    expect(appendUniqueSuffix("Before tool call", "\nAfter tool call")).toBe(
      "Before tool call\nAfter tool call",
    );
  });
});
