import type { InternalToolOutputShape } from "../agents/tool-output-shapes.js";
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
  /**
   * Tags a tool-result payload as carrying an internal shape (e.g. provider
   * inventory) whose visibility on non-direct chat surfaces is restricted.
   * The reply dispatcher reads this to suppress text on shared surfaces
   * while still allowing direct/DM delivery. Refs #75166.
   */
  internalShape?: InternalToolOutputShape;
};

export type ReplyPayloadMetadata = {
  assistantMessageIndex?: number;
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
