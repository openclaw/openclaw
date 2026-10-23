import { describe, expect, it } from "vitest";
import { inferParamBFromIdOrName, isSmallModel } from "./model-param-b.js";

describe("shared/model-param-b", () => {
  it.each([
    [{ id: "qwen2.5-coder:1.5b-instruct" }, true],
    [{ id: "qwen3:4b" }, true],
    [{ id: "model", name: "Dense 32B" }, true],
    [{ id: "model", parameterCount: 32_000_000_000 }, true],
    [{ id: "qwen:32b", parameterCount: 32_800_000_000 }, true],
    [{ id: "model", parameterCount: 33_999_999_999 }, true],
    [{ id: "model", parameterCount: 34_000_000_000 }, false],
    [{ id: "model-4b", parameterCount: 70_000_000_000 }, false],
    [{ id: "model-70b", parameterCount: 4_000_000_000 }, true],
    [{ id: "llama4-maverick-17b-128e" }, false],
    [{ id: "llama4-maverick-17b-128e", name: "Llama 4 Maverick 400B" }, false],
    [{ id: "custom-a3b" }, false],
    [{ id: "custom", name: "A3B" }, false],
    [{ id: "qwen3-30b-a3b" }, true],
    [{ id: "qwen3-235b-a22b" }, false],
    [{ id: "model", name: "Unknown size" }, false],
  ] as const)("classifies total model size for %j", (model, expected) => {
    expect(isSmallModel(model)).toBe(expected);
  });

  it("extracts the largest valid b-sized parameter token", () => {
    expect(inferParamBFromIdOrName("llama-8b mixtral-22b")).toBe(22);
    expect(inferParamBFromIdOrName("Qwen 0.5B Instruct")).toBe(0.5);
    expect(inferParamBFromIdOrName("prefix M7B and q4_32b")).toBe(32);
    expect(inferParamBFromIdOrName("(70b) + m1.5b + qwen-14b")).toBe(70);
  });

  it("matches both tokens when two are separated by a single delimiter", () => {
    expect(inferParamBFromIdOrName("8b 70b")).toBe(70);
    expect(inferParamBFromIdOrName("8b-70b")).toBe(70);
    expect(inferParamBFromIdOrName("7b-13b")).toBe(13);
  });

  it.each([
    "llama4-maverick-17b-128e",
    "llama4-scout-17b-16e-instruct",
    "Llama 4 Maverick 17B 128E",
    "custom-a3b",
    "Custom A3B",
  ])("does not infer total parameters from an active-size expert tag: %s", (id) => {
    expect(inferParamBFromIdOrName(id)).toBeNull();
  });

  it("preserves total parameter counts when active counts are also present", () => {
    expect(inferParamBFromIdOrName("qwen3-30b-a3b")).toBe(30);
    expect(inferParamBFromIdOrName("qwen3-235b-a22b")).toBe(235);
    expect(inferParamBFromIdOrName("custom-a3b Total 70B")).toBe(70);
    expect(inferParamBFromIdOrName("Total 70B custom-a3b")).toBe(70);
  });

  it.each([
    "llama4-maverick-17b-128e Llama 4 Maverick 400B",
    "Llama 4 Maverick 400B llama4-maverick-17b-128e",
  ])("preserves independent total size beside expert tags: %s", (text) => {
    expect(inferParamBFromIdOrName(text)).toBe(400);
  });

  it("ignores malformed, zero, and non-delimited matches", () => {
    expect(inferParamBFromIdOrName("abc70beta 0b x70b2")).toBeNull();
    expect(inferParamBFromIdOrName("model 0b")).toBeNull();
    expect(inferParamBFromIdOrName("model b5")).toBeNull();
    expect(inferParamBFromIdOrName("foo70bbar")).toBeNull();
    expect(inferParamBFromIdOrName("ab7b model")).toBeNull();
  });
});
