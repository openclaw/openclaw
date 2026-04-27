import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
export type ChatAttachment = {
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
};
export type ChatImageContent = {
    type: "image";
    data: string;
    mimeType: string;
};
/**
 * Metadata for an attachment that was offloaded to the media store.
 *
 * Included in ParsedMessageWithImages.offloadedRefs so that callers can
 * persist structured media metadata for transcripts. Without this, consumers
 * that derive MediaPath/MediaPaths from the `images` array (e.g.
 * persistChatSendImages and buildChatSendTranscriptMessage in chat.ts) would
 * silently omit all large attachments that were offloaded to disk.
 */
export type OffloadedRef = {
    /** Opaque media URI injected into the message, e.g. "media://inbound/<id>" */
    mediaRef: string;
    /** The raw media ID from SavedMedia.id, usable with resolveMediaBufferPath */
    id: string;
    /** Absolute filesystem path returned by saveMediaBuffer — used for transcript MediaPath */
    path: string;
    /** MIME type of the offloaded attachment */
    mimeType: string;
    /** The label / filename of the original attachment */
    label: string;
};
export type ParsedMessageWithImages = {
    message: string;
    /** Small attachments (≤ OFFLOAD_THRESHOLD_BYTES) passed inline to the model */
    images: ChatImageContent[];
    /** Original accepted attachment order after inline/offloaded split. */
    imageOrder: PromptImageOrderEntry[];
    /**
     * Large attachments (> OFFLOAD_THRESHOLD_BYTES) that were offloaded to the
     * media store. Each entry corresponds to a `[media attached: media://inbound/<id>]`
     * marker appended to `message`.
     *
     * Callers MUST persist this list separately for transcript media metadata.
     * It is intentionally separate from `images` because downstream model calls
     * do not receive these as inline image blocks.
     *
     * ⚠️  Call sites (chat.ts, agent.ts, server-node-events.ts) MUST also pass
     * `supportsImages: modelSupportsImages(model)` so text-only model runs
     * offload images as media refs instead of passing inline image blocks.
     */
    offloadedRefs: OffloadedRef[];
};
type AttachmentLog = {
    info?: (message: string) => void;
    warn: (message: string) => void;
};
/**
 * Raised when the Gateway cannot persist an attachment to the media store.
 *
 * Distinct from ordinary input-validation errors so that Gateway handlers can
 * map it to a server-side 5xx status rather than a client 4xx.
 *
 * Example causes: ENOSPC, EPERM, unexpected saveMediaBuffer return shape.
 */
export declare class MediaOffloadError extends Error {
    readonly cause: unknown;
    constructor(message: string, options?: ErrorOptions);
}
/**
 * Parse attachments and extract images as structured content blocks.
 * Returns the message text, inline image blocks, and offloaded media refs.
 *
 * ## Offload behaviour
 * Attachments whose decoded size exceeds OFFLOAD_THRESHOLD_BYTES are saved to
 * disk via saveMediaBuffer and replaced with an opaque `media://inbound/<id>`
 * URI appended to the message. The agent resolves these URIs via
 * resolveMediaBufferPath before passing them to the model.
 *
 * ## Transcript metadata
 * Callers MUST use `result.offloadedRefs` to persist structured media metadata
 * for transcripts. These refs are intentionally excluded from `result.images`
 * because they are not passed inline to the model.
 *
 * ## Text-only model runs
 * Pass `supportsImages: false` for text-only model runs so images are offloaded
 * as `media://inbound/<id>` refs instead of being sent as inline image blocks.
 * The agent runner can then resolve the refs through the normal media path.
 *
 * ## Cleanup on failure
 * On any parse failure after files have already been offloaded, best-effort
 * cleanup is performed before rethrowing so that malformed requests do not
 * accumulate orphaned files on disk ahead of the periodic TTL sweep.
 *
 * ## Known ordering limitation
 * In mixed large/small batches, the model receives images in a different order
 * than the original attachment list because detectAndLoadPromptImages
 * initialises from existingImages first, then appends prompt-detected refs.
 * A future refactor should unify all image references into a single ordered list.
 *
 * @throws {MediaOffloadError} Infrastructure failure saving to media store → 5xx.
 * @throws {Error} Input validation failure → 4xx.
 */
export declare function parseMessageWithAttachments(message: string, attachments: ChatAttachment[] | undefined, opts?: {
    maxBytes?: number;
    log?: AttachmentLog;
    supportsImages?: boolean;
}): Promise<ParsedMessageWithImages>;
/**
 * @deprecated Use parseMessageWithAttachments instead.
 * This function converts images to markdown data URLs which Claude API cannot process as images.
 */
export declare function buildMessageWithAttachments(message: string, attachments: ChatAttachment[] | undefined, opts?: {
    maxBytes?: number;
}): string;
export {};
