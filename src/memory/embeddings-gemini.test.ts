import { describe, expect, it } from "vitest";
import { DEFAULT_GEMINI_EMBEDDING_MODEL, GEMINI_MAX_INPUT_TOKENS } from "./embeddings-gemini.js";

describe("embeddings-gemini", () => {
  describe("GEMINI_MAX_INPUT_TOKENS", () => {
    it("includes gemini-embedding-001 (the default model)", () => {
      expect(GEMINI_MAX_INPUT_TOKENS[DEFAULT_GEMINI_EMBEDDING_MODEL]).toBeDefined();
    });

    it("sets gemini-embedding-001 to 8192 tokens", () => {
      expect(GEMINI_MAX_INPUT_TOKENS["gemini-embedding-001"]).toBe(8192);
    });

    it("sets text-embedding-004 to 2048 tokens", () => {
      expect(GEMINI_MAX_INPUT_TOKENS["text-embedding-004"]).toBe(2048);
    });

    it("default model is covered so maxInputTokens is never undefined", () => {
      // If the default model is not in the map, maxInputTokens would be undefined,
      // causing the embedding provider to silently skip token limiting.
      const maxTokens = GEMINI_MAX_INPUT_TOKENS[DEFAULT_GEMINI_EMBEDDING_MODEL];
      expect(typeof maxTokens).toBe("number");
      expect(maxTokens).toBeGreaterThan(0);
    });
  });
});
