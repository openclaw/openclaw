import type { ChatAttachment } from "../chat-attachments.js";
export type RpcAttachmentInput = {
    type?: unknown;
    mimeType?: unknown;
    fileName?: unknown;
    content?: unknown;
    source?: unknown;
};
export declare function normalizeRpcAttachmentsToChatAttachments(attachments: RpcAttachmentInput[] | undefined): ChatAttachment[];
