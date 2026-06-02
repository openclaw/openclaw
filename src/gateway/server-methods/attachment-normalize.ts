import type { ChatAttachment } from "../chat-attachments.js";

/** RPC attachment payload shape accepted by chat-like gateway methods. */
export type RpcAttachmentInput = {
  /** Optional attachment family forwarded to ChatAttachment when supplied as a string. */
  type?: unknown;
  /** OpenClaw-style MIME type; Anthropic source.media_type is used as fallback. */
  mimeType?: unknown;
  /** Optional display filename kept only when already string-normalized by the caller. */
  fileName?: unknown;
  /** OpenClaw-style base64 string, ArrayBuffer, or typed-array payload. */
  content?: unknown;
  /** Anthropic-style source object accepted for compatibility at the RPC boundary. */
  source?: unknown;
};

function normalizeAttachmentContent(content: unknown): string | undefined {
  // RPC callers may send browser ArrayBuffers, typed-array slices, or base64
  // strings. Normalize all accepted forms to the chat attachment wire shape.
  if (typeof content === "string") {
    return content;
  }
  if (ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("base64");
  }
  if (content instanceof ArrayBuffer) {
    return Buffer.from(content).toString("base64");
  }
  return undefined;
}

/** Convert permissive RPC attachment payloads into the bounded chat attachment shape. */
export function normalizeRpcAttachmentsToChatAttachments(
  attachments: RpcAttachmentInput[] | undefined,
): ChatAttachment[] {
  // Accept both the OpenClaw attachment fields and Anthropic-style
  // source:{type:"base64",media_type,data} payloads used by some clients.
  return (
    attachments
      ?.map((a) => {
        const source = a?.source && typeof a.source === "object" ? a.source : undefined;
        const sourceRecord = source as
          | { type?: unknown; media_type?: unknown; data?: unknown }
          | undefined;
        const sourceType = typeof sourceRecord?.type === "string" ? sourceRecord.type : undefined;
        const sourceMimeType =
          typeof sourceRecord?.media_type === "string" ? sourceRecord.media_type : undefined;
        const sourceContent =
          sourceType === "base64" ? normalizeAttachmentContent(sourceRecord?.data) : undefined;

        return {
          type: typeof a?.type === "string" ? a.type : undefined,
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : sourceMimeType,
          fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
          content: normalizeAttachmentContent(a?.content) ?? sourceContent,
        };
      })
      // Drop metadata-only entries; downstream chat handling requires content.
      .filter((a) => a.content) ?? []
  );
}
