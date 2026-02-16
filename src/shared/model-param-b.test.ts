import { describe, expect, it } from "vitest";
import { inferParamBFromIdOrName } from "./model-param-b.js";

describe("inferParamBFromIdOrName", () => {
  it("extracts param B from model names", () => {
    expect(inferParamBFromIdOrName("llama-70b")).toBe(70);
    expect(inferParamBFromIdOrName("qwen2.5-7b-instruct")).toBe(7);
    expect(inferParamBFromIdOrName("mistral-0.5b")).toBe(0.5);
  });

  it("picks largest when multiple matches", () => {
    expect(inferParamBFromIdOrName("model-7b-fine-70b")).toBe(70);
  });

  it("returns null for no match", () => {
    expect(inferParamBFromIdOrName("gpt-4o")).toBeNull();
    expect(inferParamBFromIdOrName("claude-3")).toBeNull();
    expect(inferParamBFromIdOrName("")).toBeNull();
  });

  it("handles decimal B values", () => {
    expect(inferParamBFromIdOrName("phi-3.8b")).toBe(3.8);
  });
});
