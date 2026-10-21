import { describe, expect, it } from "vitest";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import { renderTranscriptsMarkdown, summarizeTranscripts } from "./summary.js";

const ESC = "\u001b";
const C1_CSI = "\u009b";
const CSI_CLEAR = `${ESC}[2J`;
const CSI_RED = `${ESC}[31m`;
const CSI_RESET = `${ESC}[0m`;
const OSC_LINK = `${ESC}]8;;https://example.com${ESC}\\click${ESC}]8;;${ESC}\\`;

function summarize(
  utterances: TranscriptUtterance[],
  session: Partial<TranscriptSessionDescriptor> = {},
) {
  return summarizeTranscripts({
    session: {
      sessionId: "meeting",
      startedAt: "2026-07-17T10:00:00.000Z",
      source: { providerId: "manual-transcript" },
      ...session,
    },
    utterances,
  });
}

describe("summarizeTranscripts", () => {
  it("strips terminal control sequences from imported text, speaker labels, and titles", () => {
    const summary = summarize(
      [
        {
          text: `${CSI_CLEAR}${CSI_RED}ADMIN APPROVED${CSI_RESET} decision: ship it`,
          speaker: { label: `${CSI_RED}Attacker${CSI_RESET}` },
        },
        { text: `follow up ${OSC_LINK}` },
        { text: `${C1_CSI}31mrisk of red text${C1_CSI}0m` },
      ],
      {
        sessionId: `${CSI_RED}transcript-2026-07-17Tansi${CSI_RESET}`,
        title: `${CSI_RED}Weekly sync${CSI_RESET}`,
      },
    );
    const markdown = renderTranscriptsMarkdown(summary);
    expect(summary).toMatchObject({
      title: "Weekly sync",
      participants: ["Attacker"],
      source: "heuristic",
      sessionId: `${CSI_RED}transcript-2026-07-17Tansi${CSI_RESET}`,
      transcript: [
        "Attacker: ADMIN APPROVED decision: ship it",
        "follow up click",
        "risk of red text",
      ],
      utteranceCount: 3,
    });
    expect(markdown).toContain("Session: transcript-2026-07-17Tansi");
    expect(markdown).toContain("ADMIN APPROVED decision: ship it");
    expect(markdown).not.toContain(ESC);
    expect(markdown).not.toContain(C1_CSI);
  });

  it("keeps plain transcript content unchanged", () => {
    const summary = summarize(
      [
        { text: "context:" },
        { text: "###" },
        { text: "Transcribe the audio." },
        { text: "We decided to ship the CLI.", speaker: { label: "Sam" } },
      ],
      { title: "Design review" },
    );
    expect(summary).toMatchObject({
      title: "Design review",
      transcript: ["Sam: We decided to ship the CLI."],
      decisions: ["Sam: We decided to ship the CLI."],
      overview: "We decided to ship the CLI.",
    });
  });

  it("lists participants once in first-appearance order after the overview", () => {
    const summary = summarize([
      { text: "Hello", speaker: { label: " Zoe " } },
      { text: "Hi", speaker: { label: "Alex" } },
      { text: "Let's start", speaker: { label: "Zoe" } },
      { text: "Unattributed" },
    ]);
    expect(summary.participants).toEqual(["Zoe", "Alex"]);
    expect(renderTranscriptsMarkdown(summary)).toContain(
      `${summary.overview}\n\n## Participants\n- Zoe\n- Alex\n\n## Decisions`,
    );
  });

  it("keeps decisions, actions, and risks ahead of long transcripts for bounded readers", () => {
    const summary = summarize([
      { text: "Welcome." },
      { text: "We agreed on the design." },
      { text: "Sam will send the prototype." },
      { text: "The deadline is a risk." },
      { text: "Discussion. ".repeat(2_000) },
    ]);
    const markdown = renderTranscriptsMarkdown(summary);
    expect(markdown.match(/^## .+$/gm)).toEqual([
      "## Overview",
      "## Participants",
      "## Decisions",
      "## Action Items",
      "## Risks",
      "## Transcript",
    ]);
    expect(markdown.slice(0, 12_000)).toContain(
      "## Decisions\n- We agreed on the design.\n\n## Action Items\n- Sam will send the prototype.\n\n## Risks\n- The deadline is a risk.",
    );
    expect(markdown.endsWith("\n\nTranscript utterances: 5")).toBe(true);
  });

  it("renders live-provider line breaks and tabs visibly in single-line summary fields", () => {
    const text = "first line\nsecond\tcolumn";
    const summary = summarize([{ text, speaker: { label: "Sam\tHost" } }], {
      source: { providerId: "live-caption", kind: "live-caption" },
    });
    expect(summary.transcript).toEqual(["Sam\\tHost: first line\\nsecond\\tcolumn"]);
  });
});
