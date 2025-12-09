export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
};

export function buildMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number },
): string {
  const maxBytes = opts?.maxBytes ?? 2_000_000; // 2 MB
  if (!attachments || attachments.length === 0) return message;

  const blocks: string[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) continue;
    const mime = att.mimeType ?? "";
    const content = att.content;
    const label = att.fileName || att.type || `attachment-${idx + 1}`;

    if (typeof content !== "string") {
      throw new Error(`attachment ${label}: content must be base64 string`);
    }
    if (!mime.startsWith("image/")) {
      throw new Error(`attachment ${label}: only image/* supported`);
    }

    let sizeBytes = 0;
    try {
      sizeBytes = Buffer.from(content, "base64").byteLength;
    } catch {
      throw new Error(`attachment ${label}: invalid base64 content`);
    }
    if (sizeBytes <= 0 || sizeBytes > maxBytes) {
      throw new Error(
        `attachment ${label}: exceeds size limit (${sizeBytes} > ${maxBytes} bytes)`,
      );
    }

    const safeLabel = label.replace(/\s+/g, "_");
    const dataUrl = `![${safeLabel}](data:${mime};base64,${content})`;
    blocks.push(dataUrl);
  }

  if (blocks.length === 0) return message;
  const separator = message.trim().length > 0 ? "\n\n" : "";
  return `${message}${separator}${blocks.join("\n\n")}`;
}
