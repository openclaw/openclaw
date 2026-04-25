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
  /^System:\s*\[[^\]]+\]\s*Background task (?:blocked|cancelled|canceled|done|failed|lost|started|timed out|update|updated):[^\r\n]*(?:\r?\n+|$)/i;
const LEGACY_GATEWAY_RESTART_STATUS_RE =
  /^System:\s*\[[^\]]+\]\s*Gateway restart\b[^\r\n]*(?:\r?\n|$)(?:System:[^\r\n]*(?:\r?\n|$))*/i;
const LEGACY_DAY_TIMESTAMP_ENVELOPE_RE =
  /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(?:GMT|UTC)[+-]\d{1,2}\]\s*/i;
const LEGACY_RUNTIME_QUOTE_CHARS = new Set(['"', "'", "\u201c", "\u201d", "\u2018", "\u2019"]);

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

function looksLikeLegacyRuntimeText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith(INTERNAL_RUNTIME_CONTEXT_BEGIN) ||
    trimmed.startsWith("Pre-compaction memory flush.") ||
    trimmed.startsWith("An async command the user already approved has completed.") ||
    trimmed.startsWith("An async command did not run.") ||
    trimmed.startsWith("A new session was started via /new or /reset.") ||
    LEGACY_BACKGROUND_TASK_STATUS_RE.test(trimmed) ||
    LEGACY_GATEWAY_RESTART_STATUS_RE.test(trimmed)
  );
}

function unwrapLegacyRuntimeQuoteEnvelope(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return text;
  }
  const first = trimmed.at(0);
  const last = trimmed.at(-1);
  if (
    !first ||
    !last ||
    !LEGACY_RUNTIME_QUOTE_CHARS.has(first) ||
    !LEGACY_RUNTIME_QUOTE_CHARS.has(last)
  ) {
    return text;
  }
  const inner = trimmed.slice(1, -1).trim();
  return looksLikeLegacyRuntimeText(inner) ? inner : text;
}

function stripLegacyInternalOnlyPrompt(text: string): string {
  const trimmed = text.trimStart();
  if (
    trimmed.startsWith("Pre-compaction memory flush.") ||
    trimmed.startsWith("An async command the user already approved has completed.") ||
    trimmed.startsWith("An async command did not run.") ||
    trimmed.startsWith("A new session was started via /new or /reset.")
  ) {
    return "";
  }
  return text;
}

function stripLegacyBackgroundTaskStatusPrefix(text: string): string {
  if (!LEGACY_BACKGROUND_TASK_STATUS_RE.test(text)) {
    return text;
  }
  return text.replace(LEGACY_BACKGROUND_TASK_STATUS_RE, "").trimStart();
}

function stripLegacyGatewayRestartStatusPrefix(text: string): string {
  if (!LEGACY_GATEWAY_RESTART_STATUS_RE.test(text)) {
    return text;
  }
  return text.replace(LEGACY_GATEWAY_RESTART_STATUS_RE, "").trimStart();
}

function stripLegacyDayTimestampEnvelope(text: string): string {
  if (!LEGACY_DAY_TIMESTAMP_ENVELOPE_RE.test(text)) {
    return text;
  }
  return text.replace(LEGACY_DAY_TIMESTAMP_ENVELOPE_RE, "");
}

function stripVisibleTranscriptText(
  text: string,
  stripUserEnvelope: boolean,
): {
  text: string;
  changed: boolean;
} {
  const unwrapped = unwrapLegacyRuntimeQuoteEnvelope(text);
  const withoutBackgroundStatus = stripLegacyBackgroundTaskStatusPrefix(unwrapped);
  const withoutGatewayRestartStatus =
    stripLegacyGatewayRestartStatusPrefix(withoutBackgroundStatus);
  const withoutLegacyPrompt = stripLegacyInternalOnlyPrompt(withoutGatewayRestartStatus);
  const runtimeStripped = stripInternalRuntimeContext(withoutLegacyPrompt);
  const inboundStripped = stripInboundMetadata(runtimeStripped);
  const stripped = stripUserEnvelope
    ? stripMessageIdHints(stripLegacyDayTimestampEnvelope(stripEnvelope(inboundStripped)))
    : inboundStripped;
  return {
    text: stripped,
    changed: stripped !== text,
  };
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
    if (!stripped.changed) {
      next.push(item);
      continue;
    }
    changed = true;
    if (stripped.text.trim() === "") {
      continue;
    }
    next.push({
      ...entry,
      text: stripped.text,
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
    if (stripped.changed) {
      next.content = stripped.text;
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
    if (stripped.changed) {
      next.text = stripped.text;
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
