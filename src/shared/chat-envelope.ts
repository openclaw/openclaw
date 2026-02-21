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
const INBOUND_METADATA_HEADERS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
];
const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\-]/g;
const INBOUND_METADATA_PREFIX_RE = new RegExp(
  "^\\s*(?:" +
    INBOUND_METADATA_HEADERS.map((header) => header.replace(REGEX_ESCAPE_RE, "\\$&")).join("|") +
    ")\\r?\\n```json\\r?\\n[\\s\\S]*?\\r?\\n```(?:\\r?\\n)*",
);

// Pattern to match untrusted metadata blocks like:
// "Conversation info (untrusted metadata):\n```json\n{...}\n```"
// Explicitly matches: header line, opening fence (```json), content, closing fence (```)
const UNTRUSTED_METADATA_PATTERN =
  /^Conversation info \(untrusted metadata\):\n```[^\n]*\n[\s\S]*?\n```\s*/gm;

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
  // Strip envelope header first (if present)
  let stripped = text;
  const match = text.match(ENVELOPE_PREFIX);
  if (match) {
    const header = match[1] ?? "";
    if (looksLikeEnvelopeHeader(header)) {
      stripped = text.slice(match[0].length);
    }
  }

  // Then strip "Conversation info (untrusted metadata):" blocks
  const metadataMatch = stripped.match(UNTRUSTED_METADATA_PATTERN);
  if (metadataMatch) {
    return stripped.replace(metadataMatch[0], "").trim();
  }

  return stripped;
}

export function stripMessageIdHints(text: string): string {
  if (!text.includes("[message_id:")) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}

export function stripInboundMetadataBlocks(text: string): string {
  let remaining = text;
  for (;;) {
    const match = INBOUND_METADATA_PREFIX_RE.exec(remaining);
    if (!match) {
      break;
    }
    remaining = remaining.slice(match[0].length).replace(/^\r?\n+/, "");
  }
  return remaining.trim();
}
