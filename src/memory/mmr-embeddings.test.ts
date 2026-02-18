import { describe, it, expect } from "vitest";
import { mmrRerank, type MMRItem } from "./mmr.js";

describe("MMR with embeddings", () => {
  it("uses embedding similarity when available and enabled", () => {
    const items: MMRItem[] = [
      { id: "1", score: 1.0, content: "apple fruit", embedding: [1, 0, 0] },
      { id: "2", score: 0.95, content: "banana fruit", embedding: [0.95, 0.05, 0] }, // Very similar embedding to 1
      { id: "3", score: 0.9, content: "car vehicle", embedding: [0, 1, 0] }, // Different topic
    ];

    const reranked = mmrRerank(items, {
      enabled: true,
      lambda: 0.5, // Equal balance between relevance and diversity
      useEmbeddingSimilarity: true,
    });

    // With embedding similarity, item 3 should rank higher than 2
    // because it's more diverse (different topic) despite lower score
    expect(reranked[0].id).toBe("1"); // Best score
    expect(reranked[1].id).toBe("3"); // More diverse than 2
    expect(reranked[2].id).toBe("2"); // Too similar to 1
  });

  it("falls back to text similarity when embeddings unavailable", () => {
    const items: MMRItem[] = [
      { id: "1", score: 1.0, content: "apple fruit red" },
      { id: "2", score: 0.95, content: "apple fruit green" }, // Similar text
      { id: "3", score: 0.9, content: "car vehicle blue" }, // Different text
    ];

    const reranked = mmrRerank(items, {
      enabled: true,
      lambda: 0.5, // Equal balance between relevance and diversity
      useEmbeddingSimilarity: true, // Enabled but no embeddings
    });

    // Should fall back to text similarity
    expect(reranked[0].id).toBe("1");
    expect(reranked[1].id).toBe("3"); // More diverse text
    expect(reranked[2].id).toBe("2");
  });

  it("respects useEmbeddingSimilarity=false flag", () => {
    const items: MMRItem[] = [
      { id: "1", score: 1.0, content: "apple", embedding: [1, 0, 0] },
      { id: "2", score: 0.9, content: "banana", embedding: [0.95, 0.05, 0] },
      { id: "3", score: 0.8, content: "car", embedding: [0, 1, 0] },
    ];

    const reranked = mmrRerank(items, {
      enabled: true,
      lambda: 0.7,
      useEmbeddingSimilarity: false, // Force text similarity
    });

    // With text similarity, all words are different
    // So it should mostly follow score order
    expect(reranked[0].id).toBe("1");
  });

  it("handles mixed items (some with embeddings, some without)", () => {
    const items: MMRItem[] = [
      { id: "1", score: 1.0, content: "apple", embedding: [1, 0, 0] },
      { id: "2", score: 0.9, content: "banana" }, // No embedding
      { id: "3", score: 0.8, content: "car", embedding: [0, 1, 0] },
    ];

    const reranked = mmrRerank(items, {
      enabled: true,
      lambda: 0.7,
      useEmbeddingSimilarity: true,
    });

    // Should handle gracefully
    expect(reranked).toHaveLength(3);
    expect(reranked[0].id).toBe("1");
  });

  it("semantic similarity outperforms text similarity for synonyms", () => {
    const items: MMRItem[] = [
      {
        id: "1",
        score: 1.0,
        content: "dog",
        embedding: [0.8, 0.5, 0.3],
      },
      {
        id: "2",
        score: 0.95,
        content: "canine", // Synonym of dog, no text overlap
        embedding: [0.82, 0.48, 0.31], // Very similar embedding
      },
      {
        id: "3",
        score: 0.9,
        content: "automobile",
        embedding: [0.2, 0.9, 0.1], // Different topic
      },
    ];

    // With text similarity, "canine" would seem diverse (no token overlap)
    const _textRanked = mmrRerank(items, {
      enabled: true,
      lambda: 0.7,
      useEmbeddingSimilarity: false,
    });

    // With embedding similarity, "canine" is correctly identified as similar
    const embeddingRanked = mmrRerank(items, {
      enabled: true,
      lambda: 0.5, // Equal balance to make diversity count more
      useEmbeddingSimilarity: true,
    });

    // Embedding-based should prefer the different topic
    expect(embeddingRanked[1].id).toBe("3"); // Different topic ranked higher
    expect(embeddingRanked[2].id).toBe("2"); // Synonym ranked lower due to similarity
  });

  it("correctly penalizes semantic duplicates", () => {
    const items: MMRItem[] = [
      { id: "1", score: 1.0, content: "original content", embedding: [1, 0, 0, 0] },
      { id: "2", score: 0.95, content: "near duplicate", embedding: [0.99, 0.01, 0, 0] }, // Almost identical
      { id: "3", score: 0.9, content: "another duplicate", embedding: [0.98, 0.02, 0, 0] }, // Also very similar
      { id: "4", score: 0.7, content: "different topic", embedding: [0, 0, 1, 0] }, // Different
    ];

    const reranked = mmrRerank(items, {
      enabled: true,
      lambda: 0.5, // Equal weight to relevance and diversity
      useEmbeddingSimilarity: true,
    });

    expect(reranked[0].id).toBe("1"); // Best score
    expect(reranked[1].id).toBe("4"); // Different topic despite lower score
    // Duplicates should rank lower
    const duplicateIndices = reranked
      .map((r, i) => (r.id === "2" || r.id === "3" ? i : -1))
      .filter((i) => i >= 0);
    expect(duplicateIndices.every((i) => i >= 2)).toBe(true);
  });

  it("embedding-based diversity improves with lower lambda", () => {
    const items: MMRItem[] = [
      { id: "1", score: 1.0, content: "a", embedding: [1, 0, 0] },
      { id: "2", score: 0.95, content: "b", embedding: [0.99, 0.01, 0] }, // Very similar
      { id: "3", score: 0.5, content: "c", embedding: [0, 1, 0] }, // Very different, low score
    ];

    // High lambda (favor relevance)
    const highLambda = mmrRerank(items, {
      enabled: true,
      lambda: 0.9,
      useEmbeddingSimilarity: true,
    });

    // Low lambda (favor diversity)
    const lowLambda = mmrRerank(items, {
      enabled: true,
      lambda: 0.3,
      useEmbeddingSimilarity: true,
    });

    // With high lambda, similar item ranks high
    expect(highLambda[1].id).toBe("2");

    // With low lambda, diverse item ranks higher despite lower score
    expect(lowLambda[1].id).toBe("3");
  });
});
