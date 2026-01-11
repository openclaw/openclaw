import type { ClawdbotConfig, HumanDelayConfig } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { isAudio } from "../transcription.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import type { TypingController } from "./typing.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

type ReplyDispatchErrorHandler = (
  err: unknown,
  info: { kind: ReplyDispatchKind },
) => void;

type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<void>;

const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;

/** Generate a random delay within the configured range. */
function getHumanDelay(config: HumanDelayConfig | undefined): number {
  const mode = config?.mode ?? "off";
  if (mode === "off") return 0;
  const min =
    mode === "custom"
      ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS)
      : DEFAULT_HUMAN_DELAY_MIN_MS;
  const max =
    mode === "custom"
      ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS)
      : DEFAULT_HUMAN_DELAY_MAX_MS;
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Sleep for a given number of milliseconds. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute whether to skip text-only delivery for voiceOnly mode.
 * When the inbound message is audio and voiceOnly is enabled in config,
 * text replies should be skipped (but still accumulated for voice synthesis).
 *
 * @param cfg - The clawdbot config containing audio.reply.voiceOnly setting
 * @param mediaType - The MediaType of the inbound message (e.g., "audio/ogg")
 * @returns true if text-only replies should be skipped
 */
export function shouldSkipTextOnlyDelivery(
  cfg: ClawdbotConfig | undefined,
  mediaType: string | undefined | null,
): boolean {
  const inboundIsAudio = isAudio(mediaType);
  const voiceOnlyEnabled = cfg?.audio?.reply?.voiceOnly === true;
  return inboundIsAudio && voiceOnlyEnabled;
}

export type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  responsePrefix?: string;
  onHeartbeatStrip?: () => void;
  onIdle?: () => void;
  onError?: ReplyDispatchErrorHandler;
  /** Human-like delay between block replies for natural rhythm. */
  humanDelay?: HumanDelayConfig;
  /**
   * When true, skip delivery of text-only payloads (no media).
   * Text is still accumulated for voice synthesis.
   * Used for voice-only mode when inbound is audio.
   */
  skipTextOnlyDelivery?: boolean;
};

export type ReplyDispatcherWithTypingOptions = Omit<
  ReplyDispatcherOptions,
  "onIdle"
> & {
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => void;
};

type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController">;
  markDispatchIdle: () => void;
};

export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  /** Get accumulated text from all dispatched replies (for voice synthesis). */
  getAccumulatedText: () => string;
  /** Check if any reply contained media (to skip voice synthesis). */
  hasDispatchedMedia: () => boolean;
};

function normalizeReplyPayloadInternal(
  payload: ReplyPayload,
  opts: Pick<ReplyDispatcherOptions, "responsePrefix" | "onHeartbeatStrip">,
): ReplyPayload | null {
  return normalizeReplyPayload(payload, {
    responsePrefix: opts.responsePrefix,
    onHeartbeatStrip: opts.onHeartbeatStrip,
  });
}

export function createReplyDispatcher(
  options: ReplyDispatcherOptions,
): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve();
  // Track in-flight deliveries so we can emit a reliable "idle" signal.
  let pending = 0;
  // Track whether we've sent a block reply (for human delay - skip delay on first block).
  let sentFirstBlock = false;
  // Serialize outbound replies to preserve tool/block/final order.
  const queuedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  // Track accumulated text from all replies for voice synthesis.
  let accumulatedText = "";
  // Track if any reply contained media.
  let hasMedia = false;

  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const normalized = normalizeReplyPayloadInternal(payload, options);
    if (!normalized) return false;

    // Accumulate text for voice synthesis (used by dispatch-from-config).
    // This happens BEFORE checking skipTextOnlyDelivery so voice synthesis has all text.
    const text = normalized.text?.trim();
    if (text) {
      accumulatedText += (accumulatedText ? " " : "") + text;
    }

    // Check if this payload has media
    const payloadHasMedia =
      normalized.mediaUrl || (normalized.mediaUrls?.length ?? 0) > 0;

    // Track if any reply has media (to skip voice synthesis in dispatch-from-config).
    if (payloadHasMedia) {
      hasMedia = true;
    }

    // For voiceOnly mode: skip delivery of text-only payloads but count them.
    // Text is already accumulated above for voice synthesis.
    if (options.skipTextOnlyDelivery && !payloadHasMedia) {
      logVerbose(
        `voiceOnly: skipping text-only ${kind} delivery (text: ${text?.slice(0, 50)}...)`,
      );
      queuedCounts[kind] += 1;
      return true; // Counted but not delivered
    }

    queuedCounts[kind] += 1;
    pending += 1;

    // Determine if we should add human-like delay (only for block replies after the first).
    const shouldDelay = kind === "block" && sentFirstBlock;
    if (kind === "block") sentFirstBlock = true;

    sendChain = sendChain
      .then(async () => {
        // Add human-like delay between block replies for natural rhythm.
        if (shouldDelay) {
          const delayMs = getHumanDelay(options.humanDelay);
          if (delayMs > 0) await sleep(delayMs);
        }
        await options.deliver(normalized, { kind });
      })
      .catch((err) => {
        options.onError?.(err, { kind });
      })
      .finally(() => {
        pending -= 1;
        if (pending === 0) {
          options.onIdle?.();
        }
      });
    return true;
  };

  return {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    getAccumulatedText: () => accumulatedText,
    hasDispatchedMedia: () => hasMedia,
  };
}

export function createReplyDispatcherWithTyping(
  options: ReplyDispatcherWithTypingOptions,
): ReplyDispatcherWithTypingResult {
  const { onReplyStart, onIdle, ...dispatcherOptions } = options;
  let typingController: TypingController | undefined;
  const dispatcher = createReplyDispatcher({
    ...dispatcherOptions,
    onIdle: () => {
      typingController?.markDispatchIdle();
      onIdle?.();
    },
  });

  return {
    dispatcher,
    replyOptions: {
      onReplyStart,
      onTypingController: (typing) => {
        typingController = typing;
      },
    },
    markDispatchIdle: () => {
      typingController?.markDispatchIdle();
      onIdle?.();
    },
  };
}
