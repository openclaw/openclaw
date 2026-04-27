import type { MsgContext } from "../auto-reply/templating.js";
import { MediaAttachmentCache, type MediaAttachmentCacheOptions } from "./attachments.js";
import type { MediaAttachment } from "./types.js";
export declare function normalizeMediaAttachments(ctx: MsgContext): MediaAttachment[];
export declare function createMediaAttachmentCache(attachments: MediaAttachment[], options?: MediaAttachmentCacheOptions): MediaAttachmentCache;
