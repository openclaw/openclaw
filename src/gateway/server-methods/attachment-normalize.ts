type RpcAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string | Uint8Array;
};

type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string;
};

/**
 * Normalize RPC attachment payloads to plain-string content.
 * Uint8Array buffers (e.g. from typed-array transport) are base64-encoded.
 */
export function normalizeRpcAttachmentsToChatAttachments(
  attachments: RpcAttachment[],
): ChatAttachment[] {
  return attachments.map((att) => {
    const content =
      att.content instanceof Uint8Array ? Buffer.from(att.content).toString("base64") : att.content;
    return { ...att, content };
  });
}
