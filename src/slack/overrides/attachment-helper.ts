import type { SlackAttachment } from "../types.js";

/**
 * Check if message has forwarded content in attachments.
 * Returns a note for the agent to retrieve it if needed.
 */
export function getAttachmentNote(attachments?: SlackAttachment[]): string | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  // Check if this looks like a forwarded message
  const hasForwardedContent = attachments.some((att) => att.text || att.title || att.pretext);

  if (hasForwardedContent) {
    return "[Note: This message contains forwarded/attached content. Use Slack API to retrieve full content: conversations.history with the channel and message ts from above]";
  }

  return null;
}
