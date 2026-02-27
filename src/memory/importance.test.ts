import { describe, it, expect } from "vitest";
import {
  calculateImportance,
  detectContentType,
  combineScores,
  type ContentType,
} from "./importance.js";

describe("calculateImportance", () => {
  it("should return 0.5 baseline for default params", () => {
    const score = calculateImportance({
      accessCount: 0,
      lastAccessed: null,
      contentType: "general",
    });
    // With defaults: recency=0.5, frequency=0, type=0.4
    // (0.5 * 0.3) + (0 * 0.3) + (0.4 * 0.4) = 0.15 + 0 + 0.16 = 0.31
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThan(0.5);
  });

  it("should score recent access higher", () => {
    const now = Date.now();
    const recentScore = calculateImportance({
      accessCount: 1,
      lastAccessed: now - 1000, // 1 second ago
      contentType: "general",
    });
    const oldScore = calculateImportance({
      accessCount: 1,
      lastAccessed: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
      contentType: "general",
    });
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("should score higher access count higher", () => {
    const now = Date.now();
    const frequentScore = calculateImportance({
      accessCount: 10,
      lastAccessed: now,
      contentType: "general",
    });
    const rareScore = calculateImportance({
      accessCount: 1,
      lastAccessed: now,
      contentType: "general",
    });
    expect(frequentScore).toBeGreaterThan(rareScore);
  });

  it("should score decisions higher than general content", () => {
    const now = Date.now();
    const decisionScore = calculateImportance({
      accessCount: 1,
      lastAccessed: now,
      contentType: "decision",
    });
    const generalScore = calculateImportance({
      accessCount: 1,
      lastAccessed: now,
      contentType: "general",
    });
    expect(decisionScore).toBeGreaterThan(generalScore);
  });

  it("should cap frequency score at 10 accesses", () => {
    const now = Date.now();
    const tenScore = calculateImportance({
      accessCount: 10,
      lastAccessed: now,
      contentType: "general",
    });
    const hundredScore = calculateImportance({
      accessCount: 100,
      lastAccessed: now,
      contentType: "general",
    });
    // Both should be the same since frequency is capped at 10
    expect(tenScore).toBeCloseTo(hundredScore, 2);
  });

  it("should return values between 0 and 1", () => {
    const now = Date.now();
    const testCases: Array<{
      accessCount: number;
      lastAccessed: number | null;
      contentType: ContentType;
    }> = [
      { accessCount: 0, lastAccessed: null, contentType: "general" },
      { accessCount: 100, lastAccessed: now, contentType: "decision" },
      { accessCount: 5, lastAccessed: now - 15 * 24 * 60 * 60 * 1000, contentType: "preference" },
      { accessCount: 1, lastAccessed: now - 60 * 24 * 60 * 60 * 1000, contentType: "context" },
    ];

    for (const params of testCases) {
      const score = calculateImportance(params);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe("detectContentType", () => {
  it("should detect decisions", () => {
    expect(detectContentType("We decided to use TypeScript")).toBe("decision");
    expect(detectContentType("The decision was made")).toBe("decision");
    expect(detectContentType("I chose option A")).toBe("decision");
    expect(detectContentType("We will do this tomorrow")).toBe("decision");
  });

  it("should detect preferences", () => {
    expect(detectContentType("I prefer dark mode")).toBe("preference");
    expect(detectContentType("I like coffee")).toBe("preference");
    expect(detectContentType("My favorite color is blue")).toBe("preference");
    expect(detectContentType("I always use vim")).toBe("preference");
  });

  it("should detect facts", () => {
    expect(detectContentType("The server is located in AWS")).toBe("fact");
    expect(detectContentType("Email: test@example.com")).toBe("fact");
    expect(detectContentType("Version 1.2.3 was released")).toBe("fact");
    expect(detectContentType("Founded in 2020")).toBe("fact");
  });

  it("should detect context", () => {
    expect(detectContentType("In yesterday's meeting")).toBe("context");
    expect(detectContentType("We discussed the architecture")).toBe("context");
    expect(detectContentType("The conversation was about AI")).toBe("context");
  });

  it("should default to general", () => {
    expect(detectContentType("Hello world")).toBe("general");
    expect(detectContentType("Random text here")).toBe("general");
  });
});

describe("combineScores", () => {
  it("should combine similarity and importance with default weights", () => {
    // Default: 60% similarity, 40% importance
    const combined = combineScores(0.8, 0.5);
    // 0.8 * 0.6 + 0.5 * 0.4 = 0.48 + 0.2 = 0.68
    expect(combined).toBeCloseTo(0.68, 2);
  });

  it("should respect custom weights", () => {
    const combined = combineScores(0.8, 0.5, 0.5, 0.5);
    // 0.8 * 0.5 + 0.5 * 0.5 = 0.4 + 0.25 = 0.65
    expect(combined).toBeCloseTo(0.65, 2);
  });

  it("should boost high-importance results", () => {
    const lowImportance = combineScores(0.7, 0.2);
    const highImportance = combineScores(0.7, 0.9);
    expect(highImportance).toBeGreaterThan(lowImportance);
  });

  it("should still prioritize high similarity", () => {
    const highSim = combineScores(0.9, 0.3);
    const lowSim = combineScores(0.5, 0.8);
    // High similarity should still win with default weights
    expect(highSim).toBeGreaterThan(lowSim);
  });
});
