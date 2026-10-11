// Text views for matching imported CLI prompts and reading their provenance.
import { stripCliSessionDriftNote } from "../agents/cli-session.js";
import {
  normalizeInputProvenance,
  readInterSessionPromptEnvelope,
} from "../sessions/input-provenance.js";

// Some local inter-session rows store the routed text without the envelope the
// CLI received. Equal bodies only count as one message when they came from the
// same sender, so the view keeps the source next to the body.
// CLI prompts can carry OpenClaw context around the envelope and below it.
export function readRoutedPromptView(
  provenanceValue: unknown,
  rawText: string,
  isCliPrompt: boolean,
): { sender: string; body: string } | undefined {
  const text = isCliPrompt ? stripCliPromptDecorations(rawText) : rawText;
  const envelope = readInterSessionPromptEnvelope(text);
  const provenance = normalizeInputProvenance(provenanceValue) ?? envelope?.provenance;
  if (provenance?.kind !== "inter_session") {
    return undefined;
  }
  return {
    sender: JSON.stringify([provenance.sourceSessionKey ?? null, provenance.sourceTool ?? null]),
    body: isCliPrompt
      ? stripCliPromptDecorations(text.slice(envelope?.length ?? 0))
      : text.slice(envelope?.length ?? 0),
  };
}

// Queued system events reach the CLI as a block of `System:` lines above the
// prompt, separated by a blank line. The local row stores only the prompt.
// Each queued event starts with the bracketed timestamp that
// drainFormattedSystemEvents writes (UTC, zoned, or `unknown-time`), so a block
// without one is text the sender typed.
const SYSTEM_EVENT_TIMESTAMP_LINE =
  /^System: \[(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [^\s\]]+)?|unknown-time)\] /u;

function stripLeadingSystemEventLines(text: string): string {
  // Queued events can follow the producer's fenced conversation metadata.
  // Keep that context byte-identical while comparing only the event-free turn.
  const context =
    text.match(/^(?:Conversation info: )?⟦openclaw:ctx⟧\n```json\n[^\n]*\n```\n\n/u)?.[0] ?? "";
  const lines = text.slice(context.length).replace(/^\n+/u, "").split("\n");
  let end = 0;
  let hasEvent = false;
  while (end < lines.length && (lines[end] === "System:" || lines[end]?.startsWith("System: "))) {
    hasEvent ||= SYSTEM_EVENT_TIMESTAMP_LINE.test(lines[end] ?? "");
    end += 1;
  }
  if (!hasEvent || (end < lines.length && lines[end] !== "")) {
    return text;
  }
  return context + lines.slice(end).join("\n").replace(/^\n+/u, "");
}

// Correlation/provenance-only view without the context OpenClaw added around
// the user's text before handing it to the CLI. Never replace stored content.
export function stripCliPromptDecorations(text: string): string {
  const withoutGapNote = text.replace(
    /^\[OpenClaw: \d+ (?:messages occurred outside this Claude session|earlier messages in this chat) from [^\n]+\. Their contents are not included here\.[^\n]*\]\r?\n\r?\n/u,
    "",
  );
  return stripLeadingSystemEventLines(stripCliSessionDriftNote(withoutGapNote));
}
