import { describe, expect, it } from "vitest";
import { normalizeOpenAiModel, DEFAULT_OPENAI_EMBEDDING_MODEL } from "./embeddings-openai.js";

describe("normalizeOpenAiModel", () => {
  it("returns default model when input is blank", () => {
    expect(normalizeOpenAiModel("   ")).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
    expect(normalizeOpenAiModel("")).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
  });

  it("strips the openai/ prefix correctly", () => {
    expect(normalizeOpenAiModel("openai/text-embedding-3-small")).toBe("text-embedding-3-small");
    expect(normalizeOpenAiModel("openai/text-embedding-ada-002")).toBe("text-embedding-ada-002");
  });

  it("preserves explicit third-party model providers like spark/", () => {
    // This previously triggered the 'Invalid model name' bug before the provider guard was added
    expect(normalizeOpenAiModel("spark/text-embedding-3-small")).toBe(
      "spark/text-embedding-3-small",
    );
    expect(normalizeOpenAiModel("litellm/azure/ada-002")).toBe("litellm/azure/ada-002");
  });

  it("handles models without explicit prefixes appropriately", () => {
    expect(normalizeOpenAiModel("text-embedding-3-large")).toBe("text-embedding-3-large");
  });
});
