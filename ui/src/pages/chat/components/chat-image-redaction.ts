import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import { releaseChatAttachmentPayload } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { currentAttachments } from "./chat-attachment-draft.ts";
import { chatAttachmentFromDataUrl, stagedAttachmentBytes } from "./chat-attachments.ts";

export type ImageRedactionRectangle = { x: number; y: number; width: number; height: number };

/** Round outward so every selected pixel is covered, including reverse drags. */
export function paintImageRedactions(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  rectangles: readonly ImageRedactionRectangle[],
): void {
  context.fillStyle = "#000000";
  for (const rectangle of rectangles) {
    const left = Math.floor(Math.max(0, rectangle.x) * width);
    const top = Math.floor(Math.max(0, rectangle.y) * height);
    const right = Math.ceil(Math.min(1, rectangle.x + rectangle.width) * width);
    const bottom = Math.ceil(Math.min(1, rectangle.y + rectangle.height) * height);
    context.fillRect(left, top, right - left, bottom - top);
  }
}

/** Publish a new payload identity only after the current draft admits the PNG. */
export function replaceRedactedAttachment(
  original: ChatAttachment,
  dataUrl: string,
  props: ChatAttachmentControlsProps,
): boolean {
  const attachments = currentAttachments(props);
  if (
    props.disabled ||
    props.cameraActive === false ||
    props.readSignal?.aborted ||
    !uploadsEnabled(props.uploadConfig) ||
    !props.onAttachmentsChange ||
    !attachments.includes(original)
  ) {
    return false;
  }
  const retained = attachments.filter((attachment) => attachment !== original);
  const name = `${(original.fileName || "image").replace(/\.[^.]+$/, "")}-redacted.png`;
  const replacement = chatAttachmentFromDataUrl(
    dataUrl,
    name,
    props.attachmentLimits,
    stagedAttachmentBytes(props, retained),
  );
  if (!replacement) {
    return false;
  }
  let accepted = false;
  try {
    accepted =
      props.onAttachmentsChange(
        attachments.map((attachment) => (attachment === original ? replacement : attachment)),
      ) !== false;
    return accepted;
  } finally {
    releaseChatAttachmentPayload(accepted ? original.id : replacement.id);
  }
}
