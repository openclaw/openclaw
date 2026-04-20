/**
 * Browser-safe heartbeat utilities for the Control UI.
 *
 * These are inlined here rather than importing from src/auto-reply/heartbeat.ts
 * or src/auto-reply/heartbeat-filter.ts because those modules transitively import
 * Node.js built-ins (fs, os, path via src/utils.ts) which are unavailable in the
 * browser bundle.
 */

const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

// Matches the "System (untrusted): [timestamp] Exec completed/failed/finished ..." prefix
// written by the heartbeat runner when an async exec event is injected into the session.
// Real users cannot produce the "System (untrusted):" prefix — inbound sanitization rewrites it.
const EXEC_INJECTION_PREFIX_RE =
  /^System \(untrusted\): \[.+?\] Exec (completed|failed|finished)\b/i;

function resolveContentText(content: unknown): { text: string; hasNonTextContent: boolean } {
  if (typeof content === "string") {
    return { text: content, hasNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasNonTextContent: content != null };
  }
  let hasNonTextContent = false;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      hasNonTextContent = true;
      continue;
    }
    const b = block as { type: unknown; text?: unknown };
    if (b.type !== "text") {
      hasNonTextContent = true;
      continue;
    }
    if (typeof b.text !== "string") {
      hasNonTextContent = true;
      continue;
    }
    texts.push(b.text);
  }
  return { text: texts.join(""), hasNonTextContent };
}

export function isExecEventInjectionMessage(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "user") {
    return false;
  }
  const { text } = resolveContentText(message.content);
  return EXEC_INJECTION_PREFIX_RE.test(text.trimStart());
}

function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "");
}

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }
  if (!text.includes(HEARTBEAT_TOKEN)) {
    return { text, didStrip: false };
  }
  let didStrip = false;
  let changed = true;
  const endRe = new RegExp(`${HEARTBEAT_TOKEN}[^\\w]{0,4}$`);
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(HEARTBEAT_TOKEN)) {
      text = next.slice(HEARTBEAT_TOKEN.length).trimStart();
      didStrip = true;
      changed = true;
      continue;
    }
    if (endRe.test(next)) {
      const idx = next.lastIndexOf(HEARTBEAT_TOKEN);
      const before = next.slice(0, idx).trimEnd();
      const after = next.slice(idx + HEARTBEAT_TOKEN.length).trimStart();
      text = before ? `${before}${after}`.trimEnd() : "";
      didStrip = true;
      changed = true;
    }
  }
  return { text: text.replace(/\s+/g, " ").trim(), didStrip };
}

export function stripHeartbeatToken(
  raw: string | undefined,
  opts: { mode?: "heartbeat" | "message"; maxAckChars?: number } = {},
): { shouldSkip: boolean; text: string; didStrip: boolean } {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const maxAckChars =
    typeof opts.maxAckChars === "number" && Number.isFinite(opts.maxAckChars)
      ? Math.max(0, opts.maxAckChars)
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  const mode = opts.mode ?? "message";
  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken = trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);
  if (!hasToken) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }
  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }
  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }
  const rest = picked.text.trim();
  if (mode === "heartbeat" && rest.length <= maxAckChars) {
    return { shouldSkip: true, text: "", didStrip: true };
  }
  return { shouldSkip: false, text: rest, didStrip: true };
}

export function isHeartbeatOkResponse(
  message: { role: string; content?: unknown },
  ackMaxChars = 0,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const { text, hasNonTextContent } = resolveContentText(message.content);
  if (hasNonTextContent) {
    return false;
  }
  // Guard against false positives: absent or empty content is not a heartbeat ack.
  // stripHeartbeatToken returns shouldSkip=true for empty strings, which would
  // incorrectly hide legitimate assistant history entries with no content field.
  if (!text) {
    return false;
  }
  return stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars: ackMaxChars }).shouldSkip;
}
