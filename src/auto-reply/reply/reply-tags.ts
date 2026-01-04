export function extractReplyToTag(
  text?: string,
  currentMessageId?: string,
): {
  cleaned: string;
  replyToId?: string;
  hasTag: boolean;
} {
  if (!text) return { cleaned: "", hasTag: false };
  let cleaned = text;
  let replyToId: string | undefined;
  let hasTag = false;

  const currentMatch = cleaned.match(/\[\[reply_to_current\]\]/i);
  if (currentMatch) {
    cleaned = cleaned.replace(/\[\[reply_to_current\]\]/gi, " ");
    hasTag = true;
    if (currentMessageId?.trim()) {
      replyToId = currentMessageId.trim();
    }
  }

  const idMatch = cleaned.match(/\[\[reply_to:([^\]\n]+)\]\]/i);
  if (idMatch?.[1]) {
    cleaned = cleaned.replace(/\[\[reply_to:[^\]\n]+\]\]/gi, " ");
    replyToId = idMatch[1].trim();
    hasTag = true;
  }

  cleaned = cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
  return { cleaned, replyToId, hasTag };
}
