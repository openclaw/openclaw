/**
 * Strips cross-channel reply tags from Webchat messages.
 * Prevents literal tag text from appearing in the UI.
 * Addresses #53960.
 */
export function stripReplyTags(text: string): string {
    return text.replace(/\[\[\s*reply_to_current\s*\]\]/g, "").trim();
}
