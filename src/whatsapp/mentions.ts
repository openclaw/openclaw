/**
 * Extract @mentions from message text.
 * Matches patterns like @5541999998888 and converts to WhatsApp JIDs.
 * Returns an empty array when there are no mentions (safe to always include in payloads).
 */
export function extractMentions(text: string | undefined | null): string[] {
  if (!text) {
    return [];
  }
  const mentions: string[] = [];
  const phoneRegex = /@(\d{10,15})/g;
  let match: RegExpExecArray | null;
  while ((match = phoneRegex.exec(text)) !== null) {
    mentions.push(`${match[1]}@s.whatsapp.net`);
  }
  return [...new Set(mentions)];
}
