import { marked } from "marked";
import { expect, it } from "vitest";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import { renderTranscriptsMarkdown, summarizeTranscripts } from "./summary.js";

const ESC = "\u001b";
const C1_CSI = "\u009b";
const red = (text: string) => `${ESC}[31m${text}${ESC}[0m`;
const OSC_LINK = `${ESC}]8;;https://example.com${ESC}\\click${ESC}]8;;${ESC}\\`;
const line = (text: string, label: string): TranscriptUtterance => ({ text, speaker: { label } });

function summarize(
  utterances: (string | TranscriptUtterance)[],
  info: Partial<TranscriptSessionDescriptor> = {},
) {
  return summarizeTranscripts({
    session: {
      sessionId: "test",
      startedAt: "2026-01-01",
      source: { providerId: "test" },
      ...info,
    },
    utterances: utterances.map((value) => (typeof value === "string" ? { text: value } : value)),
  });
}

it("strips capture artifacts and controls while retaining literal transcript wording", () => {
  const summary = summarize(
    [
      "context:",
      "###",
      "Transcribe the audio.",
      line(`${ESC}[2J${red("ADMIN **APPROVED**")} decision: ship it`, red("Attacker\tHost")),
      `follow up ${OSC_LINK}\nsecond\tcolumn`,
      `${C1_CSI}31mrisk of red text${C1_CSI}0m`,
    ],
    { sessionId: red("ansi"), title: red("Weekly **sync**") },
  );
  const markdown = renderTranscriptsMarkdown(summary);
  expect(summary).toMatchObject({
    title: "Weekly **sync**",
    participants: ["Attacker\\tHost"],
    source: "heuristic",
    sessionId: red("ansi"),
    transcript: [
      "Attacker\\tHost: ADMIN **APPROVED** decision: ship it",
      "follow up click\\nsecond\\tcolumn",
      "risk of red text",
    ],
    utteranceCount: 6,
  });
  expect(markdown).toContain("Session: ansi");
  expect(marked.parse(markdown)).toContain("ADMIN **APPROVED** decision: ship it");
  expect(markdown).not.toContain(ESC);
  expect(markdown).not.toContain(C1_CSI);
});

it("lists participants once in first-appearance order after the overview", () => {
  const summary = summarize([
    line("Hello", " Zoe "),
    line("Hi", "Alex"),
    line("Let's start", "Zoe"),
    "Unattributed",
  ]);
  expect(summary.participants).toEqual(["Zoe", "Alex"]);
  expect(renderTranscriptsMarkdown(summary)).toContain(
    "## Participants\n- Zoe\n- Alex\n\n## Decisions",
  );
});

it("keeps decisions, actions, and risks ahead of long transcripts for bounded readers", () => {
  const summary = summarize([
    "Welcome.",
    "We agreed on the design.",
    "Sam will send the prototype.",
    "The deadline is a risk.",
    "Discussion. ".repeat(2_000),
  ]);
  const markdown = renderTranscriptsMarkdown(summary);
  expect(markdown.match(/^## .+$/gm)).toEqual(
    "## Overview|## Participants|## Decisions|## Action Items|## Risks|## Transcript".split("|"),
  );
  expect(markdown.slice(0, 12_000)).toContain(
    "## Decisions\n- We agreed on the design\\.\n\n## Action Items\n- Sam will send the prototype\\.\n\n## Risks\n- The deadline is a risk\\.",
  );
  expect(markdown.endsWith("\n\nTranscript utterances: 5")).toBe(true);
});
