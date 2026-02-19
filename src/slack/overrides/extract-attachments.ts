import type { SlackAttachment } from "./types.js";

/**
 * Extract forwarded message content from Slack attachments.
 * Forwarded messages appear in the attachments field with text content.
 */
export function extractAttachmentText(attachments?: SlackAttachment[]): string | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  const parts: string[] = [];

  for (const attachment of attachments) {
    // Collect all text-like fields from the attachment
    const textParts: string[] = [];

    if (attachment.pretext) {
      textParts.push(attachment.pretext);
    }

    if (attachment.title) {
      textParts.push(attachment.title);
    }

    if (attachment.text) {
      textParts.push(attachment.text);
    }

    if (attachment.author_name) {
      textParts.push(`— ${attachment.author_name}`);
    }

    if (attachment.fields && attachment.fields.length > 0) {
      for (const field of attachment.fields) {
        if (field.title && field.value) {
          textParts.push(`${field.title}: ${field.value}`);
        } else if (field.value) {
          textParts.push(field.value);
        }
      }
    }

    if (attachment.footer) {
      textParts.push(attachment.footer);
    }

    if (textParts.length > 0) {
      parts.push(textParts.join("\n"));
    }
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
}
