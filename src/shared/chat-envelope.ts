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

  // Then strip "Conversation info (untrusted metadata):" blocks (all occurrences)
  // Note: UNTRUSTED_METADATA_PATTERN has 'g' flag for global matching
  // Reset lastIndex before replace to avoid the test()/replace() lastIndex issue
  UNTRUSTED_METADATA_PATTERN.lastIndex = 0;
  if (UNTRUSTED_METADATA_PATTERN.test(stripped)) {
    UNTRUSTED_METADATA_PATTERN.lastIndex = 0;
    return stripped.replace(UNTRUSTED_METADATA_PATTERN, "").trim();
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
