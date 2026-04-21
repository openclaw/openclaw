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

export function extractEnvelopeSender(text: string): string | null {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) {
    return null;
  }
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) {
    return null;
  }
  // Header format: "Channel sender time" - extract sender (second part)
  const parts = header.split(" ");
  if (parts.length < 2) {
    return null;
  }
  // Remove channel prefix and combine rest as sender
  const channel = parts[0];
  if (!ENVELOPE_CHANNELS.includes(channel as (typeof ENVELOPE_CHANNELS)[number])) {
    return null;
  }
  // Sender is everything after channel up to (but not including) timestamp
  const senderParts = parts.slice(1);
  // Remove last part if it looks like a timestamp
  const lastPart = senderParts[senderParts.length - 1];
  if (
    /\d{4}-\d{2}-\nd{2}T|\d{4}-\nd{2}-
d{2} \d{2}:/.test(lastPart)
  ) {
    senderParts.pop();
  }
  return senderParts.join(" ") || null;
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
  if (!/\[message_id:/i.test(text)) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}
