import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { isTranscriptArtifactText } from "../media-understanding/transcription-text.js";
import { createTranscriptSpeakerLabels } from "./speaker-labels.js";
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

function firstSentences(utterances: TranscriptUtterance[], limit: number): string {
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

function collectMatches(utterances: TranscriptUtterance[], pattern: RegExp): string[] {
  const matches: string[] = [];
  utterances.some((utterance) => {
    if (pattern.test(utterance.text)) {
      const line = formatSpeakerLine(utterance);
      if (line) {
        matches.push(line);
      }
    }
    return matches.length >= 12;
  });
  return matches;
}

function formatSpeakerLine(utterance: TranscriptUtterance): string {
  const text = utterance.text.trim();
  if (!text) {
    return "";
  }
  const speaker = utterance.speaker?.label?.trim();
  return speaker ? `${speaker}: ${text}` : text;
}

/** Build a deterministic summary from transcript utterances. */
export function summarizeTranscripts(params: {
  session: TranscriptSessionDescriptor;
  utterances: TranscriptUtterance[];
}): TranscriptsSummary {
  const title = sanitizeTerminalText(params.session.title ?? "").trim() || "Transcripts";
  const speakerLabel = createTranscriptSpeakerLabels();
  // Reserve names in recording order, even if a particular line is filtered
  // out of the notes. The roster and Markdown export use the same order.
  const utterances = params.utterances
    .map((utterance) => ({
      ...utterance,
      text: sanitizeTerminalText(utterance.text),
      speaker: utterance.speaker && {
        ...utterance.speaker,
        label: speakerLabel(utterance.speaker.id, utterance.speaker.label),
      },
    }))
    .filter((utterance) => !isTranscriptArtifactText(utterance.text));
  const overview =
    firstSentences(utterances, 4) ||
    (params.session.stoppedAt ? "No usable speech was captured." : "No transcript captured yet.");
  return {
    sessionId: params.session.sessionId,
    title,
    generatedAt: new Date().toISOString(),
    overview,
    participants: normalizeUniqueStringEntries(
      utterances.map((utterance) => utterance.speaker?.label ?? ""),
    ),
    source: "heuristic",
    transcript: utterances.map(formatSpeakerLine).filter(Boolean),
    decisions: collectMatches(utterances, DECISION_PATTERNS),
    actionItems: collectMatches(utterances, ACTION_PATTERNS),
    risks: collectMatches(utterances, RISK_PATTERNS),
    utteranceCount: params.utterances.length,
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
