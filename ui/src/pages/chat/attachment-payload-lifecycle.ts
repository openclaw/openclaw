import type { ChatAttachment } from "../../lib/chat/chat-types.ts";

export type AttachmentPayload = {
  blob?: Blob;
  dataUrl?: string;
  previewUrl?: string;
  videoPoster?: {
    controller: AbortController;
    promise: Promise<string | null>;
    url?: string;
  };
};

// Application teardown needs synchronous release without loading media preparation.
export const payloads = new Map<string, AttachmentPayload>();

export function revokeObjectUrl(url: string | undefined): void {
  if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  URL.revokeObjectURL(url);
}

export function releaseVideoPoster(payload: AttachmentPayload): void {
  payload.videoPoster?.controller.abort();
  revokeObjectUrl(payload.videoPoster?.url);
}

export function releaseChatAttachmentPayload(id: string): void {
  const payload = payloads.get(id);
  if (!payload) {
    return;
  }
  releaseVideoPoster(payload);
  revokeObjectUrl(payload.previewUrl);
  payloads.delete(id);
}

export function releaseChatAttachmentPayloads(attachments: readonly ChatAttachment[] = []): void {
  for (const attachment of attachments) {
    releaseChatAttachmentPayload(attachment.id);
  }
}
