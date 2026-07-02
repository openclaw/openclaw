// Tests for transcript summarization and markdown rendering.
import { describe, expect, it } from "vitest";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import {
  renderTranscriptsMarkdown,
  summarizeTranscripts,
  type TranscriptsSummary,
} from "./summary.js";

function makeSession(overrides: Partial<TranscriptSessionDescriptor> = {}): TranscriptSessionDescriptor {
  return {
    sessionId: "test-session-1",
    source: { providerId: "test" },
    startedAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  };
}

function makeUtterance(text: string, speakerLabel?: string): TranscriptUtterance {
  return {
    text,
    speaker: speakerLabel ? { label: speakerLabel } : undefined,
  };
}

describe("summarizeTranscripts", () => {
  it("uses session title when available", () => {
    const session = makeSession({ title: "Q3 Planning" });
    const summary = summarizeTranscripts({ session, utterances: [] });
    expect(summary.title).toBe("Q3 Planning");
  });

  it('falls back to "Transcripts" when title is missing', () => {
    const session = makeSession({ title: undefined });
    const summary = summarizeTranscripts({ session, utterances: [] });
    expect(summary.title).toBe("Transcripts");
  });

  it('falls back to "Transcripts" when title is whitespace-only', () => {
    const session = makeSession({ title: "   " });
    const summary = summarizeTranscripts({ session, utterances: [] });
    expect(summary.title).toBe("Transcripts");
  });

  it("includes sessionId in the summary", () => {
    const session = makeSession({ sessionId: "sess-abc" });
    const summary = summarizeTranscripts({ session, utterances: [] });
    expect(summary.sessionId).toBe("sess-abc");
  });

  it("generates a timestamp for generatedAt", () => {
    const summary = summarizeTranscripts({ session: makeSession(), utterances: [] });
    expect(summary.generatedAt).toBeTruthy();
    expect(() => new Date(summary.generatedAt)).not.toThrow();
  });

  describe("overview", () => {
    it("extracts up to the first 4 sentences as overview", () => {
      const utterances = [makeUtterance("First point. Second thought. Third idea. Fourth note. Fifth extra.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.overview).toContain("First point");
      expect(summary.overview).toContain("Fourth note");
      expect(summary.overview).not.toContain("Fifth extra");
    });

    it('returns fallback text when no utterances exist', () => {
      const summary = summarizeTranscripts({ session: makeSession(), utterances: [] });
      expect(summary.overview).toBe("No transcript captured yet.");
    });

    it("joins text across multiple utterances for overview", () => {
      const utterances = [
        makeUtterance("We reviewed the Q2 results."),
        makeUtterance("The numbers look good overall."),
      ];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.overview).toContain("We reviewed the Q2 results");
      expect(summary.overview).toContain("The numbers look good overall");
    });
  });

  describe("decisions", () => {
    it("captures lines matching decision patterns", () => {
      const utterances = [makeUtterance("We decided to use TypeScript for the new project.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.decisions.length).toBeGreaterThan(0);
      expect(summary.decisions[0]).toContain("decided");
    });

    it("matches 'go with' as a decision signal", () => {
      const utterances = [makeUtterance("Let's go with the PostgreSQL option.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.decisions.length).toBeGreaterThan(0);
    });

    it("returns empty array when no decision patterns match", () => {
      const utterances = [makeUtterance("Just chatting about the weather.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.decisions).toEqual([]);
    });

    it("caps decisions at 12 entries", () => {
      const utterances = Array.from({ length: 20 }, (_, i) =>
        makeUtterance(`We decided item ${i}.`),
      );
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.decisions.length).toBeLessThanOrEqual(12);
    });
  });

  describe("actionItems", () => {
    it("captures lines matching action patterns", () => {
      const utterances = [makeUtterance("TODO: update the documentation before release.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.actionItems.length).toBeGreaterThan(0);
      expect(summary.actionItems[0]).toContain("TODO");
    });

    it("matches 'follow up' as an action signal", () => {
      const utterances = [makeUtterance("I will follow up with the design team.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.actionItems.length).toBeGreaterThan(0);
    });
  });

  describe("risks", () => {
    it("captures lines matching risk patterns", () => {
      const utterances = [makeUtterance("There is a risk of missing the deadline.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.risks.length).toBeGreaterThan(0);
      expect(summary.risks[0]).toContain("risk");
    });

    it("matches 'blocked' as a risk signal", () => {
      const utterances = [makeUtterance("We are blocked on the API key approval.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.risks.length).toBeGreaterThan(0);
    });

    it("matches 'security' as a risk signal", () => {
      const utterances = [makeUtterance("There is a security concern with that approach.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.risks.length).toBeGreaterThan(0);
    });
  });

  describe("speaker formatting", () => {
    it("prefixes utterance with speaker label", () => {
      const utterances = [makeUtterance("Hello everyone.", "Alice")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.transcript[0]).toBe("Alice: Hello everyone.");
    });

    it("uses plain text when speaker is absent", () => {
      const utterances = [makeUtterance("Hello everyone.")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.transcript[0]).toBe("Hello everyone.");
    });

    it("omits empty utterances from transcript", () => {
      const utterances = [makeUtterance("Valid.", "Alice"), makeUtterance("   ", "Bob")];
      const summary = summarizeTranscripts({ session: makeSession(), utterances });
      expect(summary.transcript).toHaveLength(1);
    });
  });

  it("records the utterance count", () => {
    const utterances = [makeUtterance("One."), makeUtterance("Two."), makeUtterance("Three.")];
    const summary = summarizeTranscripts({ session: makeSession(), utterances });
    expect(summary.utteranceCount).toBe(3);
  });
});

describe("renderTranscriptsMarkdown", () => {
  it("renders all expected sections", () => {
    const summary: TranscriptsSummary = {
      sessionId: "sess-1",
      title: "Test Summary",
      generatedAt: "2026-07-02T10:00:00.000Z",
      overview: "This is an overview.",
      transcript: ["Alice: Hello"],
      decisions: ["Use TypeScript"],
      actionItems: ["Update docs"],
      risks: ["Tight deadline"],
      utteranceCount: 42,
    };
    const markdown = renderTranscriptsMarkdown(summary);
    expect(markdown).toContain("# Test Summary");
    expect(markdown).toContain("Generated: 2026-07-02T10:00:00.000Z");
    expect(markdown).toContain("Session: sess-1");
    expect(markdown).toContain("## Overview");
    expect(markdown).toContain("This is an overview.");
    expect(markdown).toContain("## Transcript");
    expect(markdown).toContain("- Alice: Hello");
    expect(markdown).toContain("## Decisions");
    expect(markdown).toContain("- Use TypeScript");
    expect(markdown).toContain("## Action Items");
    expect(markdown).toContain("- Update docs");
    expect(markdown).toContain("## Risks");
    expect(markdown).toContain("- Tight deadline");
    expect(markdown).toContain("Transcript utterances: 42");
  });

  it('renders "None captured" for empty lists', () => {
    const summary: TranscriptsSummary = {
      sessionId: "sess-2",
      title: "Empty",
      generatedAt: "2026-07-02T10:00:00.000Z",
      overview: "Nothing here.",
      transcript: [],
      decisions: [],
      actionItems: [],
      risks: [],
      utteranceCount: 0,
    };
    const markdown = renderTranscriptsMarkdown(summary);
    const noneCaptured = (markdown.match(/- None captured/g) ?? []).length;
    expect(noneCaptured).toBe(4); // transcript, decisions, actionItems, risks
  });

  it("renders multiple transcript lines", () => {
    const summary: TranscriptsSummary = {
      sessionId: "sess-3",
      title: "Multi",
      generatedAt: "2026-07-02T10:00:00.000Z",
      overview: "Ok.",
      transcript: ["A: line1", "B: line2", "C: line3"],
      decisions: [],
      actionItems: [],
      risks: [],
      utteranceCount: 3,
    };
    const markdown = renderTranscriptsMarkdown(summary);
    expect(markdown).toContain("- A: line1");
    expect(markdown).toContain("- B: line2");
    expect(markdown).toContain("- C: line3");
  });
});
