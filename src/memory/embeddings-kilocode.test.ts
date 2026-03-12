import { describe, expect, it } from "vitest";
import { DEFAULT_KILOCODE_EMBEDDING_MODEL, normalizeKilocodeModel } from "./embeddings-kilocode.js";

describe("normalizeKilocodeModel", () => {
  it("returns the default model for empty values", () => {
    expect(normalizeKilocodeModel("")).toBe(DEFAULT_KILOCODE_EMBEDDING_MODEL);
    expect(normalizeKilocodeModel("   ")).toBe(DEFAULT_KILOCODE_EMBEDDING_MODEL);
  });

  it("strips the kilocode/ prefix", () => {
    expect(normalizeKilocodeModel("kilocode/openai/text-embedding-3-small")).toBe(
      "openai/text-embedding-3-small",
    );
    expect(normalizeKilocodeModel("  kilocode/mistralai/mistral-embed  ")).toBe(
      "mistralai/mistral-embed",
    );
  });

  it("keeps non-prefixed models including sub-provider prefixes", () => {
    expect(normalizeKilocodeModel("mistralai/mistral-embed")).toBe("mistralai/mistral-embed");
    expect(normalizeKilocodeModel("openai/text-embedding-3-small")).toBe(
      "openai/text-embedding-3-small",
    );
    expect(normalizeKilocodeModel("custom-embed-v2")).toBe("custom-embed-v2");
  });
});
