import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  stripInternalRuntimeContext,
} from "../agents/internal-runtime-context.js";
import {
  extractInboundSenderLabel,
  stripInboundMetadata,
} from "../auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export { stripEnvelope };

const LEGACY_BACKGROUND_TASK_STATUS_RE =
  /^System:\s*\[[^\]]+\]\s*Background task (?:blocked|cancelled|done|failed|lost|started|timed out|update):[^\n]*(?:\r?\n)+/i;

function unwrapLegacyRuntimeQuoteEnvelope(text: string): string {
  const trimmed = text.trim();
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ];
  for (const [open, close] of quotePairs) {
    if (!trimmed.startsWith(open)) {
      continue;
    }
    const inner = trimmed.endsWith(close) ? trimmed.slice(1, -1) : trimmed.slice(1);
    if (looksLikeLegacyRuntimeText(inner)) {
      return inner;
    }
  }
  return text;
}

function looksLikeLegacyRuntimeText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith(INTERNAL_RUNTIME_CONTEXT_BEGIN) ||
    trimmed.startsWith("Pre-compaction memory flush.") ||
    trimmed.startsWith("An async command the user already approved has completed.") ||
    trimmed.startsWith("An async command did not run.") ||
    trimmed.startsWith("A new session was started via /new or /reset.") ||
    /^System:\s*\[[^\]]+\]\s*Background task\b/i.test(trimmed)
  );
}

function stripLegacyInternalOnlyPrompt(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.startsWith("Pre-compaction memory flush.") &&
    trimmed.includes("Store durable memories") &&
    trimmed.includes("NO_REPLY")
  ) {
    return "";
  }
  if (
    (trimmed.startsWith("An async command the user already approved has completed.") ||
      trimmed.startsWith("An async command did not run.")) &&
    trimmed.includes("Exact completion details:")
  ) {
    return "";
  }
  if (
    trimmed.startsWith("A new session was started via /new or /reset.") &&
    trimmed.includes("Session Startup sequence") &&
    trimmed.includes("Current time:")
  ) {
    return "";
  }
  return text;
}

function stripLegacyBackgroundTaskStatusPrefix(text: string): string {
  const unwrapped = unwrapLegacyRuntimeQuoteEnvelope(text);
  if (!/^System:\s*\[[^\]]+\]\s*Background task\b/i.test(unwrapped.trimStart())) {
    return text;
  }
  return unwrapped.trimStart().replace(LEGACY_BACKGROUND_TASK_STATUS_RE, "");
}

function stripVisibleTranscriptText(text: string, stripUserEnvelope: boolean): string {
  const backgroundStripped = stripLegacyBackgroundTaskStatusPrefix(text);
  const quoteUnwrapped = unwrapLegacyRuntimeQuoteEnvelope(backgroundStripped);
  const runtimeStripped = stripInternalRuntimeContext(quoteUnwrapped);
  const internalPromptStripped = stripLegacyInternalOnlyPrompt(runtimeStripped);
  const inboundStripped = stripInboundMetadata(internalPromptStripped);
  const stripped = stripUserEnvelope
    ? stripMessageIdHints(stripEnvelope(inboundStripped))
    : inboundStripped;
  return stripLegacyInternalOnlyPrompt(stripped);
}

function extractMessageSenderLabel(entry: Record<string, unknown>): string | null {
  if (typeof entry.senderLabel === "string" && entry.senderLabel.trim()) {
    return entry.senderLabel.trim();
  }
  if (typeof entry.content === "string") {
    return extractInboundSenderLabel(entry.content);
  }
  if (Array.isArray(entry.content)) {
    for (const item of entry.content) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string") {
        continue;
      }
      const senderLabel = extractInboundSenderLabel(text);
      if (senderLabel) {
        return senderLabel;
      }
    }
  }
  if (typeof entry.text === "string") {
    return extractInboundSenderLabel(entry.text);
  }
  return null;
}

function stripEnvelopeFromContentWithRole(
  content: unknown[],
  stripUserEnvelope: boolean,
): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next: unknown[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      next.push(item);
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") {
      next.push(item);
      continue;
    }
    const stripped = stripVisibleTranscriptText(entry.text, stripUserEnvelope);
    if (!stripped.trim()) {
      if (stripped !== entry.text) {
        changed = true;
        continue;
      }
      next.push(item);
      continue;
    }
    if (stripped === entry.text) {
      next.push(item);
      continue;
    }
    changed = true;
    next.push({
      ...entry,
      text: stripped,
    });
  }
  return { content: next, changed };
}

export function stripEnvelopeFromMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? normalizeLowercaseStringOrEmpty(entry.role) : "";
  const stripUserEnvelope = role === "user";

  let changed = false;
  const next: Record<string, unknown> = { ...entry };
  const senderLabel = stripUserEnvelope ? extractMessageSenderLabel(entry) : null;
  if (senderLabel && entry.senderLabel !== senderLabel) {
    next.senderLabel = senderLabel;
    changed = true;
  }

  if (typeof entry.content === "string") {
    const stripped = stripVisibleTranscriptText(entry.content, stripUserEnvelope);
    if (stripped !== entry.content) {
      next.content = stripped;
      changed = true;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = stripEnvelopeFromContentWithRole(entry.content, stripUserEnvelope);
    if (updated.changed) {
      next.content = updated.content;
      changed = true;
    }
  } else if (typeof entry.text === "string") {
    const stripped = stripVisibleTranscriptText(entry.text, stripUserEnvelope);
    if (stripped !== entry.text) {
      next.text = stripped;
      changed = true;
    }
  }

  return changed ? next : message;
}

export function stripEnvelopeFromMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next = messages.map((message) => {
    const stripped = stripEnvelopeFromMessage(message);
    if (stripped !== message) {
      changed = true;
    }
    return stripped;
  });
  return changed ? next : messages;
}
