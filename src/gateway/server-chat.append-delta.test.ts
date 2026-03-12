import { describe, expect, it } from "vitest";
import { appendDelta } from "./server-chat.js";

describe("appendDelta", () => {
  it("returns suffix when base is empty", () => {
    expect(appendDelta("", "hello")).toBe("hello");
  });

  it("returns base when suffix is empty", () => {
    expect(appendDelta("hello", "")).toBe("hello");
  });

  it("concatenates non-overlapping text", () => {
    expect(appendDelta("hello", " world")).toBe("hello world");
  });

  // ---- Regression tests for #43828: repeated characters ----

  it("does not deduplicate single repeated char", () => {
    expect(appendDelta("9", "9")).toBe("99");
  });

  it("does not deduplicate multi-char repeated suffix", () => {
    expect(appendDelta("99", "99")).toBe("9999");
  });

  it("handles streaming repeated single-char deltas", () => {
    // Simulate streaming "999999" one token at a time
    let accumulated = "9";
    for (let i = 0; i < 5; i++) {
      accumulated = appendDelta(accumulated, "9");
    }
    expect(accumulated).toBe("999999");
  });

  it("handles streaming repeated multi-char deltas", () => {
    let accumulated = "ha";
    accumulated = appendDelta(accumulated, "ha");
    accumulated = appendDelta(accumulated, "ha");
    expect(accumulated).toBe("hahaha");
  });

  it("handles streaming repeated word tokens", () => {
    let accumulated = "the ";
    accumulated = appendDelta(accumulated, "the ");
    accumulated = appendDelta(accumulated, "the ");
    expect(accumulated).toBe("the the the ");
  });

  it("concatenates segment boundaries correctly", () => {
    // Simulates text segments after tool calls
    expect(appendDelta("Before tool call", "\nAfter tool call")).toBe(
      "Before tool call\nAfter tool call",
    );
  });
});
