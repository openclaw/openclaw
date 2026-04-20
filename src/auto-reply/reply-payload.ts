import path from "node:path";
import type {
  InteractiveReply,
  MessagePresentation,
  ReplyPayloadDelivery,
} from "../interactive/payload.js";

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  /** Internal-only trust signal for gateway webchat local media embedding. */
  trustedLocalMedia?: boolean;
  /** Treat media as live-only content and avoid persisting the underlying media reference. */
  sensitiveMedia?: boolean;
  /** Channel-agnostic rich presentation. Core degrades or asks the channel renderer to map it. */
  presentation?: MessagePresentation;
  /** Channel-agnostic delivery preferences, e.g. pin the sent message when supported. */
  delivery?: ReplyPayloadDelivery;
  /**
   * @deprecated Use presentation.
   *
   * Internal legacy representation used by existing approval/reply helpers during migration.
   */
  interactive?: InteractiveReply;
  btw?: {
    question: string;
  };
  replyToId?: string;
  replyToTag?: boolean;
  /** True when [[reply_to_current]] was present but not yet mapped to a message id. */
  replyToCurrent?: boolean;
  /** Send audio as voice message (bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
  /**
   * Text synthesized into an audio-only TTS payload. Exposed to hooks for
   * archival/search use when no visible channel text is sent.
   */
  spokenText?: string;
  isError?: boolean;
  /** Marks this payload as a reasoning/thinking block. Channels that do not
   *  have a dedicated reasoning lane (e.g. WhatsApp, web) should suppress it. */
  isReasoning?: boolean;
  /** Marks this payload as a compaction status notice (start/end).
   *  Should be excluded from TTS transcript accumulation so compaction
   *  status lines are not synthesised into the spoken assistant reply. */
  isCompactionNotice?: boolean;
  /** Channel-specific payload data (per-channel envelope). */
  channelData?: Record<string, unknown>;
  /** Media items that were dropped during normalization (blocked, inaccessible, etc.). */
  droppedMedia?: DroppedMediaItem[];
};

export type DroppedMediaReasonCode =
  | "normalization-failed"
  | "blocked-path"
  | "file-not-accessible"
  | "data-url-rejected"
  | "unknown";

export type DroppedMediaItem = {
  displayName: string;
  code: DroppedMediaReasonCode;
};

/** Strip directory components from a media source so user-facing notices
 *  never expose full filesystem paths. */
export function sanitizeMediaDisplayName(mediaSource: string): string {
  if (/^data:/i.test(mediaSource)) {
    return "(inline data)";
  }
  // Normalize Windows backslash paths for cross-platform safety
  const normalized = mediaSource.replace(/\\/g, "/");
  return path.basename(normalized) || mediaSource;
}

/** Derive a reason code from the error thrown during media normalization. */
export function resolveDroppedMediaCode(err: unknown): DroppedMediaReasonCode {
  if (!(err instanceof Error)) {
    return "unknown";
  }
  const msg = err.message.toLowerCase();
  if (msg.includes("blocked")) {
    return "blocked-path";
  }
  if (msg.includes("data url") || /\bdata:\s*[a-z]/i.test(err.message)) {
    return "data-url-rejected";
  }
  if (
    msg.includes("enoent") ||
    msg.includes("not found") ||
    msg.includes("no such file") ||
    msg.includes("not accessible")
  ) {
    return "file-not-accessible";
  }
  return "unknown";
}

export type ReplyPayloadMetadata = {
  assistantMessageIndex?: number;
  /**
   * Internal OpenClaw notices generated after a runtime/provider failure are
   * not assistant source replies. Dispatch may deliver them even when normal
   * assistant source replies are message-tool-only; sendPolicy deny still wins.
   */
  deliverDespiteSourceReplySuppression?: boolean;
  beforeAgentRunBlocked?: boolean;
};

const replyPayloadMetadata = new WeakMap<object, ReplyPayloadMetadata>();

export function setReplyPayloadMetadata<T extends object>(
  payload: T,
  metadata: ReplyPayloadMetadata,
): T {
  const previous = replyPayloadMetadata.get(payload);
  replyPayloadMetadata.set(payload, { ...previous, ...metadata });
  return payload;
}

export function getReplyPayloadMetadata(payload: object): ReplyPayloadMetadata | undefined {
  return replyPayloadMetadata.get(payload);
}

export function copyReplyPayloadMetadata<T extends object>(source: object, payload: T): T {
  const metadata = getReplyPayloadMetadata(source);
  return metadata ? setReplyPayloadMetadata(payload, metadata) : payload;
}

export function markReplyPayloadForSourceSuppressionDelivery<T extends object>(payload: T): T {
  return setReplyPayloadMetadata(payload, {
    deliverDespiteSourceReplySuppression: true,
  });
}
