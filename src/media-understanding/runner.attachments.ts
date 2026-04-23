import type { MsgContext } from "../auto-reply/templating.js";
import {
  MediaAttachmentCache,
  type MediaAttachmentCacheOptions,
  normalizeAttachments,
} from "./attachments.js";
import type { MediaAttachment } from "./types.js";

export function normalizeMediaAttachments(ctx: MsgContext): MediaAttachment[] {
  return normalizeAttachments(ctx);
}

export function createMediaAttachmentCache(
  attachments: MediaAttachment[],
  options?: MediaAttachmentCacheOptions,
): MediaAttachmentCache {
  return new MediaAttachmentCache(attachments, options);
}
