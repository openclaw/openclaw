import { describe, expect, it } from "vitest";
import type { CompactionCheckpoint, ExperientialMoment, SessionSummary } from "./types.js";
import { buildReconstitutionContext, determineDepth } from "./reconstitution.js";

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sum-1",
    version: 1,
    sessionKey: "agent:main:main",
    startedAt: Date.now() - 3600000,
    endedAt: Date.now(),
    topics: ["API design"],
    momentCount: 3,
    keyAnchors: ["decided on REST"],
    openUncertainties: ["auth approach"],
    reconstitutionHints: ["Session focused on: API design"],
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<CompactionCheckpoint> = {}): CompactionCheckpoint {
  return {
    id: "cp-1",
    version: 1,
    timestamp: Date.now(),
    sessionKey: "agent:main:main",
    trigger: "compaction",
    activeTopics: ["database schema"],
    keyContextSummary: "discussed db schema",
    openUncertainties: [],
    conversationAnchors: ["migration plan finalized"],
    ...overrides,
  };
}

function makeMoment(overrides: Partial<ExperientialMoment> = {}): ExperientialMoment {
  return {
    id: "mom-1",
    version: 1,
    timestamp: Date.now(),
    sessionKey: "agent:main:main",
    source: "message",
    content: "Important architecture decision",
    significance: {
      total: 0.8,
      emotional: 0.5,
      uncertainty: 0.3,
      relationship: 0.4,
      consequential: 0.7,
      reconstitution: 0.8,
    },
    disposition: "immediate",
    reasons: [],
    anchors: [],
    uncertainties: [],
    ...overrides,
  };
}

describe("reconstitution", () => {
  describe("determineDepth", () => {
    it("returns deep for null timestamp", () => {
      expect(determineDepth(null)).toBe("deep");
    });

    it("returns quick for recent activity (<4h)", () => {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      expect(determineDepth(twoHoursAgo)).toBe("quick");
    });

    it("returns standard for moderate gap (4-24h)", () => {
      const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
      expect(determineDepth(twelveHoursAgo)).toBe("standard");
    });

    it("returns deep for long gap (>24h)", () => {
      const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
      expect(determineDepth(twoDaysAgo)).toBe("deep");
    });
  });

  describe("buildReconstitutionContext", () => {
    it("returns empty state message when no data", () => {
      const result = buildReconstitutionContext({
        depth: "deep",
        summaries: [],
        checkpoints: [],
        moments: [],
      });
      expect(result).toContain("No prior experiential data");
    });

    it("includes session topics for quick depth", () => {
      const result = buildReconstitutionContext({
        depth: "quick",
        summaries: [makeSummary()],
        checkpoints: [],
        moments: [],
      });
      expect(result).toContain("API design");
      expect(result).toContain("Recent Sessions");
    });

    it("limits summaries based on depth", () => {
      const summaries = [
        makeSummary({ id: "s1", topics: ["topic-1"] }),
        makeSummary({ id: "s2", topics: ["topic-2"] }),
        makeSummary({ id: "s3", topics: ["topic-3"] }),
      ];

      const quick = buildReconstitutionContext({
        depth: "quick",
        summaries,
        checkpoints: [],
        moments: [],
      });
      const standard = buildReconstitutionContext({
        depth: "standard",
        summaries,
        checkpoints: [],
        moments: [],
      });
      const deep = buildReconstitutionContext({
        depth: "deep",
        summaries,
        checkpoints: [],
        moments: [],
      });

      // Quick shows only 1 summary
      expect(quick).toContain("topic-1");
      expect(quick).not.toContain("topic-2");

      // Standard shows 2
      expect(standard).toContain("topic-1");
      expect(standard).toContain("topic-2");
      expect(standard).not.toContain("topic-3");

      // Deep shows all 3
      expect(deep).toContain("topic-3");
    });

    it("excludes checkpoints for quick depth", () => {
      const result = buildReconstitutionContext({
        depth: "quick",
        summaries: [],
        checkpoints: [makeCheckpoint()],
        moments: [],
      });
      expect(result).not.toContain("Context Checkpoints");
    });

    it("includes checkpoints for standard depth", () => {
      const result = buildReconstitutionContext({
        depth: "standard",
        summaries: [],
        checkpoints: [makeCheckpoint()],
        moments: [],
      });
      expect(result).toContain("Context Checkpoints");
      expect(result).toContain("database schema");
    });

    it("includes significant moments only for deep depth", () => {
      const moments = [makeMoment({ emotionalSignature: "excited" })];

      const quick = buildReconstitutionContext({
        depth: "quick",
        summaries: [],
        checkpoints: [],
        moments,
      });
      const deep = buildReconstitutionContext({
        depth: "deep",
        summaries: [],
        checkpoints: [],
        moments,
      });

      expect(quick).not.toContain("Significant Moments");
      expect(deep).toContain("Significant Moments");
      expect(deep).toContain("excited");
    });
  });
});
