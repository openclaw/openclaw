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

const UNTRUSTED_METADATA_BLOCK =
  /^(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply) \(untrusted[^)]*\):[\s\S]*?```\n\n/gm;

export function stripEnvelope(text: string): string {
  // First, strip [Channel ...] style envelopes
  const match = text.match(ENVELOPE_PREFIX);
  if (match) {
    const header = match[1] ?? "";
    if (looksLikeEnvelopeHeader(header)) {
      text = text.slice(match[0].length);
    }
  }

  // Then, strip untrusted metadata blocks
  text = text.replace(UNTRUSTED_METADATA_BLOCK, "");

  return text;
}

export function stripMessageIdHints(text: string): string {
  if (!text.includes("[message_id:")) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}
