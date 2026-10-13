// Text views for matching imported CLI prompts and reading their provenance.
import { stripCliSessionDriftNote } from "../agents/cli-session.js";
import {
  LEGACY_REQUESTER_PROFILE_HINT,
  readLeadingInboundMetadataEnd,
} from "../auto-reply/reply/strip-inbound-meta.js";
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
): { sender: string; originalBody: string; body: string } | undefined {
  const text = isCliPrompt ? stripCliPromptDecorations(rawText) : rawText;
  const envelope = readInterSessionPromptEnvelope(text);
  const provenance = normalizeInputProvenance(provenanceValue) ?? envelope?.provenance;
  if (provenance?.kind !== "inter_session") {
    return undefined;
  }
  return {
    sender: JSON.stringify([provenance.sourceSessionKey ?? null, provenance.sourceTool ?? null]),
    originalBody: text.slice(envelope?.length ?? 0),
    // The old bare requester prefix belonged outside the envelope; inside it is sender text.
    body: isCliPrompt
      ? stripCliPromptDecorations(text.slice(envelope?.length ?? 0), Boolean(envelope))
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

function stripLeadingSystemEventLines(text: string, preserveRequesterGuidance: boolean): string {
  // Events follow generated inbound context, including recent chat history.
  // Locate that prefix without applying display cleanup to later user text.
  // Historical native rows may retain the old unmarked requester companion.
  // This frame identifies attached hints; the shared parser owns its boundary.
  const conversationFrame =
    text.match(
      /^(?:Conversation info: )?⟦openclaw:ctx⟧\r?\n```json\r?\n[^\n]*\r?\n```\r?\n\r?\n/u,
    )?.[0] ?? "";
  const label =
    conversationFrame && !text.startsWith("Conversation info: ") ? "Conversation info: " : "";
  const context = text.slice(
    0,
    readLeadingInboundMetadataEnd(label ? label + text : text) - label.length,
  );
  const afterFrame = text.slice(conversationFrame.length);
  const newline = afterFrame.startsWith(`${LEGACY_REQUESTER_PROFILE_HINT}\r\n`) ? "\r\n" : "\n";
  const hint = `${LEGACY_REQUESTER_PROFILE_HINT}${newline}${newline}`;
  const body = context
    ? text.slice(context.length)
    : !preserveRequesterGuidance && text.startsWith(hint)
      ? text.slice(hint.length)
      : text;
  const retainedContext =
    conversationFrame && afterFrame.startsWith(hint) && context.length > conversationFrame.length
      ? ""
      : context;
  const source = body.replace(/^(?:\r?\n)+/u, "");
  const lines = source.split("\n");
  let end = 0;
  let endOffset = 0;
  let hasEvent = false;
  while (end < lines.length) {
    const line = (lines[end] ?? "").replace(/\r$/u, "");
    if (line !== "System:" && !line.startsWith("System: ")) {
      break;
    }
    hasEvent ||= SYSTEM_EVENT_TIMESTAMP_LINE.test(line);
    endOffset += (lines[end]?.length ?? 0) + 1;
    end += 1;
  }
  if (!hasEvent || (end < lines.length && lines[end]?.replace(/\r$/u, "") !== "")) {
    return retainedContext + body;
  }
  return retainedContext + source.slice(endOffset).replace(/^(?:\r?\n)+/u, "");
}

// Correlation/provenance-only view without the context OpenClaw added around
// the user's text before handing it to the CLI. Never replace stored content.
export function stripCliPromptDecorations(text: string, preserveRequesterGuidance = false): string {
  const withoutGapNote = text.replace(
    /^\[OpenClaw: \d+ (?:messages occurred outside this Claude session|earlier messages in this chat) from [^\n]+\. Their contents are not included here\.[^\n]*\]\r?\n\r?\n/u,
    "",
  );
  return stripLeadingSystemEventLines(
    stripCliSessionDriftNote(withoutGapNote),
    preserveRequesterGuidance,
  );
}
