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

// Check if sender part looks like a group/room label rather than a person
// Group indicators: #channel, "group:", "guild:", numeric-only IDs, etc.
function looksLikeGroupSender(senderPart: string): boolean {
  const trimmed = senderPart.trim();
  // Starts with # (Discord channel)
  if (trimmed.startsWith("#")) return true;
  // Contains group: or guild: prefix (room identifiers)
  if (/group:|guild:|channel:/i.test(trimmed)) return true;
  // Numeric only (just an ID with no name) - group labels often are just IDs
  if (/^\d+$/.test(trimmed)) return true;
  return false;
}

// Check if header looks like a group chat based on channel format
function looksLikeGroupHeader(header: string): boolean {
  // Group indicators in the header: "group:", "guild:", "channel:", or # prefix
  if (/group:|guild:|channel:/i.test(header)) return true;
  // If the channel name starts with something other than a known channel, might be a group
  // But typically we check if the sender part looks like a group/room
  return false;
}

export function extractEnvelopeSender(
  text: string,
  chatType?: "direct" | "group",
): string | null {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) {
    return null;
  }
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) {
    return null;
  }
  // Find which channel this is (handles multi-word channels like "Google Chat")
  const channelMatch = ENVELOPE_CHANNELS.find((c) => header.startsWith(`${c} `));
  if (!channelMatch) {
    return null;
  }
  // Extract sender part after channel name
  const senderPart = header.slice(channelMatch.length + 1).trim();
  if (!senderPart) {
    return null;
  }
  // Exclude group/room sender parts (they would misidentify the actual sender)
  if (looksLikeGroupSender(senderPart)) {
    return null;
  }
  // If caller explicitly specified chat type, respect it
  // Only use envelope sender for direct chats (matching steipete's design intent)
  if (chatType === "group") {
    return null;
  }
  // If chatType is explicit "direct", proceed
  // If chatType is undefined, use heuristic: if header looks like a group, skip
  if (chatType === undefined && looksLikeGroupHeader(header)) {
    return null;
  }
  // Remove trailing timestamp if present (last part with 4-digit year)
  const parts = senderPart.split(" ");
  if (parts.length > 1) {
    const lastPart = parts[parts.length - 1];
    if (lastPart && /\d{4}/.test(lastPart)) {
      parts.pop();
    }
  }
  return parts.join(" ") || null;
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