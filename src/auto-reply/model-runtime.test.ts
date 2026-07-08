/** Tests for model-runtime helper functions. */
import { describe, expect, it } from "vitest";
import { formatProviderModelRef } from "./model-runtime.js";

describe("formatProviderModelRef", () => {
  it("returns the bare model when the provider is empty", () => {
    expect(formatProviderModelRef("", "gpt-5.4")).toBe("gpt-5.4");
  });

  it("returns the bare provider when the model is empty", () => {
    expect(formatProviderModelRef("minimax", "")).toBe("minimax");
  });

  it("joins provider and model with a slash", () => {
    expect(formatProviderModelRef("openai", "gpt-5.4")).toBe("openai/gpt-5.4");
  });

  it("dedupes the same provider prefix when embedded in the model", () => {
    expect(formatProviderModelRef("openai", "openai/gpt-5.4")).toBe("openai/gpt-5.4");
    expect(formatProviderModelRef("minimax", "minimax/MiniMax-M3")).toBe("minimax/MiniMax-M3");
  });

  it("dedupes the same provider prefix case-insensitively", () => {
    expect(formatProviderModelRef("OpenAI", "openai/gpt-5.4")).toBe("OpenAI/gpt-5.4");
    expect(formatProviderModelRef("openai", "OPENAI/gpt-5.4")).toBe("openai/gpt-5.4");
  });

  it("strips a foreign provider prefix embedded in the model", () => {
    // Regression: previously produced "minimax/openai/gpt-5.4" which is malformed.
    expect(formatProviderModelRef("minimax", "openai/gpt-5.4")).toBe("minimax/gpt-5.4");
    expect(formatProviderModelRef("openai", "anthropic/claude-opus-4-6")).toBe(
      "openai/claude-opus-4-6",
    );
  });

  it("strips a foreign provider prefix case-insensitively", () => {
    expect(formatProviderModelRef("minimax", "OpenAI/gpt-5.4")).toBe("minimax/gpt-5.4");
    expect(formatProviderModelRef("MiniMax", "openai/gpt-5.4")).toBe("MiniMax/gpt-5.4");
  });

  it("preserves multi-segment model names that start with the same provider", () => {
    expect(formatProviderModelRef("anthropic", "anthropic/claude-opus-4-6")).toBe(
      "anthropic/claude-opus-4-6",
    );
  });

  it("returns the joined form when the model has no slash", () => {
    expect(formatProviderModelRef("minimax", "MiniMax-M3")).toBe("minimax/MiniMax-M3");
  });

  it("returns the bare model when only the model looks like provider/model but provider is empty", () => {
    expect(formatProviderModelRef("", "openai/gpt-5.4")).toBe("openai/gpt-5.4");
  });

  it("handles whitespace-trimmed inputs", () => {
    expect(formatProviderModelRef("  minimax  ", "  openai/gpt-5.4  ")).toBe("minimax/gpt-5.4");
  });

  it("falls back to the original model when the foreign provider prefix has no remainder", () => {
    // Edge case: model is "openai/" (with trailing slash). The remaining string is empty,
    // so the function falls back to the original naive join to avoid producing a label
    // like "minimax/" with nothing after it.
    expect(formatProviderModelRef("minimax", "openai/")).toBe("minimax/openai/");
  });
});
