import { describe, expect, it } from "vitest";
import { isOpenAiEmbedding3Model, resolveOpenAiOutputDimensionality } from "./embeddings-openai.js";

describe("OpenAI Matryoshka (outputDimensionality) support", () => {
  describe("isOpenAiEmbedding3Model", () => {
    it("returns true for text-embedding-3-small", () => {
      expect(isOpenAiEmbedding3Model("text-embedding-3-small")).toBe(true);
    });

    it("returns true for text-embedding-3-large", () => {
      expect(isOpenAiEmbedding3Model("text-embedding-3-large")).toBe(true);
    });

    it("returns false for text-embedding-ada-002", () => {
      expect(isOpenAiEmbedding3Model("text-embedding-ada-002")).toBe(false);
    });

    it("returns false for unknown models", () => {
      expect(isOpenAiEmbedding3Model("text-embedding-unknown")).toBe(false);
    });
  });

  describe("resolveOpenAiOutputDimensionality", () => {
    describe("text-embedding-3-small", () => {
      it("returns default 1536 when no value provided", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-small")).toBe(1536);
      });

      it("returns 512 when requested", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-small", 512)).toBe(512);
      });

      it("returns 1024 when requested", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-small", 1024)).toBe(1024);
      });

      it("returns 1536 when requested", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-small", 1536)).toBe(1536);
      });

      it("throws for invalid dimension 128", () => {
        expect(() => resolveOpenAiOutputDimensionality("text-embedding-3-small", 128)).toThrowError(
          "Invalid outputDimensionality 128",
        );
      });

      it("throws for invalid dimension 2048", () => {
        expect(() =>
          resolveOpenAiOutputDimensionality("text-embedding-3-small", 2048),
        ).toThrowError("Invalid outputDimensionality 2048");
      });
    });

    describe("text-embedding-3-large", () => {
      it("returns default 3072 when no value provided", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-large")).toBe(3072);
      });

      it("returns 512 when requested", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-large", 512)).toBe(512);
      });

      it("returns 2048 when requested", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-large", 2048)).toBe(2048);
      });

      it("returns 3072 when requested", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-3-large", 3072)).toBe(3072);
      });
    });

    describe("text-embedding-ada-002 (no Matryoshka support)", () => {
      it("returns undefined when no value provided", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-ada-002")).toBeUndefined();
      });

      it("returns undefined even when value requested", () => {
        expect(resolveOpenAiOutputDimensionality("text-embedding-ada-002", 512)).toBeUndefined();
      });
    });
  });
});
