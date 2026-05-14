import { describe, expect, it } from "vitest";
import { chunkText, estimateTokens } from "./chunking.js";

describe("contextmesh chunking", () => {
  it("estimates tokens deterministically", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("splits large text into multiple chunks", () => {
    const text = Array.from({ length: 800 }, (_, index) => `word${index}`).join(" ");
    const chunks = chunkText(text, { maxChunkTokens: 120, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.id).toBe("chunk-1");
  });
});
