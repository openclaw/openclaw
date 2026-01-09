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

  const currentMatch = cleaned.match(/\[\[\s*reply_to_current\s*\]\]/i);
  if (currentMatch) {
    cleaned = cleaned.replace(/\[\[\s*reply_to_current\s*\]\]/gi, " ");
    hasTag = true;
    if (currentMessageId?.trim()) {
      replyToId = currentMessageId.trim();
    }
  }

  const idMatch = cleaned.match(/\[\[\s*reply_to\s*:\s*([^\]\n]+)\s*\]\]/i);
  if (idMatch?.[1]) {
    cleaned = cleaned.replace(/\[\[\s*reply_to\s*:[^\]\n]+\]\]/gi, " ");
    replyToId = idMatch[1].trim();
    hasTag = true;
  }

  cleaned = cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
  return { cleaned, replyToId, hasTag };
}
