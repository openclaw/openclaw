import { describe, expect, it } from "vitest";
import { DEFAULT_MISTRAL_EMBEDDING_MODEL, normalizeMistralModel } from "./embeddings-mistral.js";

describe("normalizeMistralModel", () => {
  it("returns the default model for empty values", () => {
    expect(normalizeMistralModel("")).toBe(DEFAULT_MISTRAL_EMBEDDING_MODEL);
    expect(normalizeMistralModel("   ")).toBe(DEFAULT_MISTRAL_EMBEDDING_MODEL);
  });

  it("strips the mistral/ prefix", () => {
    expect(normalizeMistralModel("mistral/mistral-embed")).toBe("mistral-embed");
    expect(normalizeMistralModel("  mistral/custom-embed  ")).toBe("custom-embed");
  });

  it("keeps explicit non-prefixed models", () => {
    expect(normalizeMistralModel("mistral-embed")).toBe("mistral-embed");
    expect(normalizeMistralModel("custom-embed-v2")).toBe("custom-embed-v2");
  });
});
