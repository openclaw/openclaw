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

// Block label patterns from buildInboundUserContextPrefix():
// "(untrusted metadata):" â€” Conversation info, Sender, Forwarded
// "(untrusted, for context):" â€” Thread starter, Replied message, Chat history
const UNTRUSTED_BLOCK_MARKERS = ["(untrusted metadata):", "(untrusted, for context):"];
const UNTRUSTED_METADATA_FENCE = "```";

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

/**
 * Strip all fenced JSON blocks injected by buildInboundUserContextPrefix()
 * from inbound user messages. Matches both "(untrusted metadata):" and
 * "(untrusted, for context):" label suffixes â€” covering all six block types.
 * Fixes #20221, #20279.
 */
export function stripUntrustedMetadataBlocks(text: string): string {
  if (!UNTRUSTED_BLOCK_MARKERS.some((m) => text.includes(m))) {
    return text;
  }
  let result = text;
  // Iteratively strip leading "(untrusted metadata):" + fenced json blocks.
  while (true) {
    const positions = UNTRUSTED_BLOCK_MARKERS.map((m) => result.indexOf(m)).filter((i) => i !== -1);
    const markerPos = positions.length > 0 ? Math.min(...positions) : -1;
    if (markerPos === -1) {
      break;
    }
    // The label is preceded by a line like "Conversation info (untrusted metadata):".
    // Find the newline that terminates that label line.
    const lineEnd = result.indexOf("\n", markerPos);
    if (lineEnd === -1) {
      break;
    }
    // Expect ```json immediately after the label line.
    const fenceStart = result.indexOf(UNTRUSTED_METADATA_FENCE, lineEnd + 1);
    if (fenceStart !== lineEnd + 1) {
      break;
    }
    // Find the closing fence.
    const fenceEnd = result.indexOf(UNTRUSTED_METADATA_FENCE, fenceStart + 3);
    if (fenceEnd === -1) {
      break;
    }
    // Consume up to and including the closing fence + optional trailing newlines.
    const blockEnd = fenceEnd + 3;
    const labelStart = result.lastIndexOf("\n", markerPos - 1) + 1;
    result = result.slice(0, labelStart) + result.slice(blockEnd).replace(/^\n{0,2}/, "");
  }
  return result.trimStart();
}

export function stripMessageIdHints(text: string): string {
  if (!text.includes("[message_id:")) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !MESSAGE_ID_LINE.test(line));
  return filtered.length === lines.length ? text : filtered.join("\n");
}
