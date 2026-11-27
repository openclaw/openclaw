import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  createTranscriptSpeakerLabels,
  formatTranscriptTurn,
  presentTranscriptTurns,
  type TranscriptDisplayTurn,
} from "./speaker-labels.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptUtterance,
  TranscriptsSummary,
} from "./types.js";

const ACTION_PATTERNS =
  /\b(todo|action|follow up|follow-up|assign|owner|next step|ship|fix|send|schedule)\b/i;
const DECISION_PATTERNS = /\b(decided|decision|we will|we'll|agreed|approved|go with|ship it)\b/i;
const RISK_PATTERNS =
  /\b(risk|blocked|blocker|concern|issue|problem|unknown|deadline|privacy|security)\b/i;

function firstSentences(utterances: TranscriptDisplayTurn[], limit: number): string {
  const text = normalizeStringEntries(utterances.map((utterance) => utterance.text)).join(" ");
  const sentences: string[] = [];
  for (const match of text.matchAll(/[^.!?]+[.!?]?/g)) {
    sentences.push(match[0]);
    // Whitespace-only matches count toward the limit before normalization.
    if (sentences.length >= limit) {
      break;
    }
  }
  return normalizeStringEntries(sentences).join(" ");
}

function collectMatches(utterances: TranscriptDisplayTurn[], pattern: RegExp): string[] {
  const matches: string[] = [];
  utterances.some((utterance) => {
    if (pattern.test(utterance.text)) {
      matches.push(formatTranscriptTurn(utterance));
    }
    return matches.length >= 12;
  });
  return matches;
}

/** Prepare notes for direct callers that supply original capture utterances. */
export function summarizeTranscripts(
  params: { session: TranscriptSessionDescriptor; utterances: TranscriptUtterance[] },
  speakerLabel = createTranscriptSpeakerLabels(),
): TranscriptsSummary {
  const turns = presentTranscriptTurns(
    params.utterances.map((row) => ({
      text: row.text,
      startedAt: row.startedAt,
      speakerLabel: speakerLabel(row.speaker?.id, row.speaker?.label),
    })),
  );
  return summarizeTranscriptTurns(params.session, turns, params.utterances.length);
}

/** Summarize already-presented turns in speech order. The count includes filtered rows. */
export function summarizeTranscriptTurns(
  session: TranscriptSessionDescriptor,
  utterances: TranscriptDisplayTurn[],
  utteranceCount: number,
): TranscriptsSummary {
  const title = sanitizeTerminalText(session.title ?? "").trim() || "Transcripts";
  const overview =
    firstSentences(utterances, 4) ||
    (session.stoppedAt ? "No usable speech was captured." : "No transcript captured yet.");
  return {
    sessionId: session.sessionId,
    title,
    generatedAt: new Date().toISOString(),
    overview,
    participants: normalizeUniqueStringEntries(
      utterances.map((utterance) => utterance.speakerLabel),
    ),
    source: "heuristic",
    transcript: utterances.map(formatTranscriptTurn),
    decisions: collectMatches(utterances, DECISION_PATTERNS),
    actionItems: collectMatches(utterances, ACTION_PATTERNS),
    risks: collectMatches(utterances, RISK_PATTERNS),
    utteranceCount,
  };
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None captured";
}

/** Render a transcript summary as markdown for local artifacts. */
export function renderTranscriptsMarkdown(summary: TranscriptsSummary): string {
  return [
    `# ${summary.title}`,
    "",
    `Generated: ${summary.generatedAt}`,
    `Session: ${sanitizeTerminalText(summary.sessionId)}`,
    "",
    "## Overview",
    summary.overview,
    "",
    "## Participants",
    // Persisted summaries from before participant metadata remain renderable.
    renderList(summary.participants ?? []),
    "",
    "## Decisions",
    renderList(summary.decisions),
    "",
    "## Action Items",
    renderList(summary.actionItems),
    "",
    "## Risks",
    renderList(summary.risks),
    "",
    // Keep notes ahead of the transcript for bounded readers such as tool show.
    "## Transcript",
    renderList(summary.transcript),
    "",
    `Transcript utterances: ${summary.utteranceCount}`,
  ].join("\n");
}
