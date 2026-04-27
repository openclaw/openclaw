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
  /** Internal legacy representation used by existing approval/reply helpers during migration. */
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
};

export type ReplyPayloadMetadata = {
  assistantMessageIndex?: number;
  /**
   * Speech-preparation source text for tag-aware TTS providers (e.g. ElevenLabs v3).
   * When present, providers that declare `sourceTextHandling: "preserve_expressive_tags"`
   * receive this text *with expressive tags preserved* (rather than the visible
   * variant, which may have had tags stripped for chat display). Note this is not
   * forwarded byte-for-byte: the TTS pipeline still trims, strips markdown, may
   * summarize when the text exceeds `maxLength`, and applies a hard length cap —
   * `ttsSourceText` only controls *which* string those steps run on.
   * An explicit empty string is meaningful and is not equivalent to omission:
   * it tells the TTS pipeline there is no usable tag-aware source variant.
   *
   * Pair with `ttsPlainText` when the visible reply text may still contain expressive
   * tags (e.g. `/emotions full` mode) — otherwise non-tag-aware providers in the
   * fallback chain will speak the tag words out loud.
   */
  ttsSourceText?: string;
  /**
   * Display-sanitized speech text for TTS providers that declare
   * `sourceTextHandling: "strip_expressive_tags"` (the default). When omitted, the
   * runtime falls back to the visible reply text — which is correct in
   * `/emotions off|on` modes where visible text is already display-sanitized, but
   * leaks tag words to plain providers in `/emotions full` mode.
   * An explicit empty string is meaningful and is not equivalent to omission:
   * it tells the TTS pipeline to skip plain-text provider variants rather than
   * falling back to visible text.
   */
  ttsPlainText?: string;
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

/**
 * Copy `ReplyPayloadMetadata` from `source` onto `target`. Use when you create
 * a new payload object via spread (`{...source, text: visible}`) — the metadata
 * is keyed by object identity in a `WeakMap`, so spread creates a new object
 * that has no metadata. Per Copilot review on the speech-core TTS pipeline.
 */
export function cloneReplyPayloadMetadata<T extends object>(source: object, target: T): T {
  const metadata = replyPayloadMetadata.get(source);
  return metadata ? setReplyPayloadMetadata(target, metadata) : target;
}
