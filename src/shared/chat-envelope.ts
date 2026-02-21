const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "Google Chat",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const MESSAGE_ID_LINE = /^\s*\[message_id:\s*[^\]]+\]\s*$/i;

function looksLikeEnvelopeHeader(header: string): boolean {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) {
    return true;
  }
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) {
    return true;
  }
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `));
}

export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) {
    return text;
  }
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) {
    return text;
  }
  return text.slice(match[0].length);
}

export function stripMessageIdHints(text: string): string {
  if (!text.includes("[message_id:")) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}

/**
 * Matches a single inbound-user-context metadata block produced by
 * `buildInboundUserContextPrefix` in `src/auto-reply/reply/inbound-meta.ts`.
 *
 * Each block looks like:
 *   <Label> (untrusted metadata|untrusted, for context):\n```json\n<JSON>\n```
 *
 * The regex is anchored so it only matches from the current position
 * (used with lastIndex / sticky flag via the loop below).
 */
const INBOUND_CONTEXT_BLOCK =
  /[^\n]*\(untrusted(?:,? (?:metadata|for context))\):\n```json\n[\s\S]*?\n```/;

/**
 * Strip inbound-user-context metadata blocks that `buildInboundUserContextPrefix`
 * prepends to user messages for agent context.  These blocks should never be
 * shown in the webchat/macOS UI.
 *
 * Returns the original user text with leading metadata blocks removed.
 * If the entire text consists of metadata, returns an empty string.
 */
export function stripInboundUserContext(text: string): string {
  if (!text.includes("(untrusted")) {
    return text;
  }
  let remaining = text;
  while (true) {
    const match = remaining.match(INBOUND_CONTEXT_BLOCK);
    if (!match || match.index === undefined) {
      break;
    }
    // Only strip blocks anchored at the very start (possibly after whitespace).
    const before = remaining.slice(0, match.index);
    if (before.trim().length > 0) {
      break;
    }
    remaining = remaining.slice(match.index + match[0].length);
  }
  return remaining.replace(/^\n+/, "");
}
