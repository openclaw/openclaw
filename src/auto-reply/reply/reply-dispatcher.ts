import type { TypingCallbacks } from "../../channels/typing.js";
import type { HumanDelayConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateSecureInt } from "../../infra/secure-random.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { sleep } from "../../utils.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { registerDispatcher } from "./dispatcher-registry.js";
import { normalizeReplyPayload, type NormalizeReplySkipReason } from "./normalize-reply.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
import type { TypingController } from "./typing.js";

export type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

type ReplyDispatchErrorHandler = (err: unknown, info: { kind: ReplyDispatchKind }) => void;

type ReplyDispatchSkipHandler = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind; reason: NormalizeReplySkipReason },
) => void;

type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<unknown>;

export type ReplyDispatchBeforeDeliver = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<ReplyPayload | null> | ReplyPayload | null;

const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;
const silentReplyLogger = createSubsystemLogger("silent-reply/dispatcher");

/** Generate a random delay within the configured range. */
function getHumanDelay(config: HumanDelayConfig | undefined): number {
  const mode = config?.mode ?? "off";
  if (mode === "off") {
    return 0;
  }
  const min =
    mode === "custom" ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS) : DEFAULT_HUMAN_DELAY_MIN_MS;
  const max =
    mode === "custom" ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS) : DEFAULT_HUMAN_DELAY_MAX_MS;
  if (max <= min) {
    return min;
  }
  return min + generateSecureInt(max - min + 1);
}

export type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  silentReplyContext?: {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    surface?: string;
    conversationType?: SilentReplyConversationType;
  };
  responsePrefix?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  /** Static context for response prefix template interpolation. */
  responsePrefixContext?: ResponsePrefixContext;
  /** Dynamic context provider for response prefix template interpolation.
   * Called at normalization time, after model selection is complete. */
  responsePrefixContextProvider?: () => ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  onIdle?: () => void;
  onError?: ReplyDispatchErrorHandler;
  // AIDEV-NOTE: onSkip lets channels detect silent/empty drops (e.g. Telegram empty-response fallback).
  onSkip?: ReplyDispatchSkipHandler;
  /** Human-like delay between block replies for natural rhythm. */
  humanDelay?: HumanDelayConfig;
  beforeDeliver?: ReplyDispatchBeforeDeliver;
  /**
   * Turn-level NO_REPLY suppression (substrate-leak fix).
   *
   * When enabled (default true), `block`-kind payloads are BUFFERED at enqueue time
   * and held until the `final` payload arrives. At final-arrival:
   *   - if final is exact NO_REPLY → drop the entire buffer + drop final (no delivery)
   *   - otherwise                  → flush buffer in order, then deliver final
   *
   * This is the only correct shape for "reasoning-block-first-then-NO_REPLY-second"
   * suppression: a pre-final flag-check cannot work because the flag is unset at the
   * moment the reasoning block enqueues.
   *
   * Tool-kind payloads bypass the buffer (they are between the model and tool-runs,
   * not user-visible chat). Setting this option false restores legacy
   * "deliver-each-block-immediately" behavior for callers who need it.
   *
   * @see substrate-leak forensic 2026-05-24 session cf23b629
   */
  enableTurnLevelNoReplySuppression?: boolean;
};

export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
  typingCallbacks?: TypingCallbacks;
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => void;
  onSettled?: () => unknown;
  /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
  onCleanup?: () => void;
};

type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
  markDispatchIdle: () => void;
  /** Signal that the model run is complete so the typing controller can stop. */
  markRunComplete: () => void;
};

type NormalizeReplyPayloadInternalOptions = Pick<
  ReplyDispatcherOptions,
  | "responsePrefix"
  | "responsePrefixContext"
  | "responsePrefixContextProvider"
  | "onHeartbeatStrip"
  | "transformReplyPayload"
> & {
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

function normalizeReplyPayloadInternal(
  payload: ReplyPayload,
  opts: NormalizeReplyPayloadInternalOptions,
): ReplyPayload | null {
  // Prefer dynamic context provider over static context
  const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;

  return normalizeReplyPayload(payload, {
    responsePrefix: opts.responsePrefix,
    responsePrefixContext: prefixContext,
    onHeartbeatStrip: opts.onHeartbeatStrip,
    transformReplyPayload: opts.transformReplyPayload,
    onSkip: opts.onSkip,
  });
}

export function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve();
  // Track in-flight deliveries so we can emit a reliable "idle" signal.
  // Start with pending=1 as a "reservation" to prevent premature gateway restart.
  // This is decremented when markComplete() is called to signal no more replies will come.
  let pending = 1;
  let completeCalled = false;
  // Track whether we've sent a block reply (for human delay - skip delay on first block).
  let sentFirstBlock = false;
  // Serialize outbound replies to preserve tool/block/final order.
  const queuedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  const failedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  const cancelledCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };

  // Turn-level NO_REPLY suppression: buffer block-kind payloads until final arrives.
  // See ReplyDispatcherOptions.enableTurnLevelNoReplySuppression for full rationale.
  const enableTurnLevelSuppression = options.enableTurnLevelNoReplySuppression ?? true;
  // Buffer of block payloads enqueued before final lands. Flushed (or dropped) at final.
  const bufferedBlocks: ReplyPayload[] = [];

  // Register this dispatcher globally for gateway restart coordination.
  const { unregister } = registerDispatcher({
    pending: () => pending,
    waitForIdle: () => sendChain,
  });

  /**
   * Push a normalized payload onto the serialized send chain.
   * Returns true and bumps queued/pending counters; caller is responsible for
   * the upstream "did anything actually get queued" boolean.
   */
  const dispatchNormalized = (kind: ReplyDispatchKind, normalized: ReplyPayload): void => {
    queuedCounts[kind] += 1;
    pending += 1;

    // Determine if we should add human-like delay (only for block replies after the first).
    const shouldDelay = kind === "block" && sentFirstBlock;
    if (kind === "block") {
      sentFirstBlock = true;
    }

    sendChain = sendChain
      .then(async () => {
        // Add human-like delay between block replies for natural rhythm.
        if (shouldDelay) {
          const delayMs = getHumanDelay(options.humanDelay);
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        }
        let deliverPayload: ReplyPayload | null = normalized;
        if (options.beforeDeliver) {
          deliverPayload = await options.beforeDeliver(normalized, { kind });
          if (!deliverPayload) {
            cancelledCounts[kind] += 1;
            return;
          }
        }
        await options.deliver(deliverPayload, { kind });
      })
      .catch((err) => {
        failedCounts[kind] += 1;
        options.onError?.(err, { kind });
      })
      .finally(() => {
        pending -= 1;
        // Clear reservation if:
        // 1. pending is now 1 (just the reservation left)
        // 2. markComplete has been called
        // 3. No more replies will be enqueued
        if (pending === 1 && completeCalled) {
          pending -= 1; // Clear the reservation
        }
        if (pending === 0) {
          // Unregister from global tracking when idle.
          unregister();
          options.onIdle?.();
        }
      });
  };

  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const originalWasExactSilent = isSilentReplyText(payload.text, SILENT_REPLY_TOKEN);

    // ── Turn-level NO_REPLY suppression (buffer-until-final) ─────────────────
    //
    // The substrate-leak shape is:
    //   1. enqueue(block, "reasoning text")   ← in current model output
    //   2. enqueue(tool,  {tool-output})       ← model called a tool
    //   3. enqueue(block, "more reasoning")    ← post-tool reasoning
    //   4. enqueue(final, "NO_REPLY")          ← model's final answer
    //
    // A flag-on-NO_REPLY approach can't catch (1) or (3) because the flag is
    // unset at the moment those blocks enqueue. The correct fix is to defer
    // block-kind delivery until final arrives, then decide.
    //
    // Tool-kind is NOT buffered — it must flow to the agent loop so the model
    // can keep running. Final-kind is the trigger for flush-or-drop.

    if (enableTurnLevelSuppression && kind === "block") {
      // Normalize NOW so transformReplyPayload / heartbeat-strip / response-prefix
      // semantics still happen at enqueue-time-ordering. If normalization drops
      // it (e.g. empty text, or transformer returned null), record the skip and
      // do nothing — same as legacy behavior.
      const normalized = normalizeReplyPayloadInternal(payload, {
        responsePrefix: options.responsePrefix,
        responsePrefixContext: options.responsePrefixContext,
        responsePrefixContextProvider: options.responsePrefixContextProvider,
        transformReplyPayload: options.transformReplyPayload,
        onHeartbeatStrip: options.onHeartbeatStrip,
        onSkip: (reason) => options.onSkip?.(payload, { kind, reason }),
      });
      if (!normalized) {
        return false;
      }
      bufferedBlocks.push(normalized);
      return true;
    }

    if (enableTurnLevelSuppression && kind === "final") {
      if (originalWasExactSilent) {
        // Drop everything buffered (the leak) and drop the final itself.
        const droppedCount = bufferedBlocks.length;
        if (droppedCount > 0) {
          silentReplyLogger.debug(
            "turn-level NO_REPLY suppression: dropping buffered block(s) before final NO_REPLY",
            {
              droppedBlockCount: droppedCount,
              hasSessionKey: Boolean(options.silentReplyContext?.sessionKey),
              surface: options.silentReplyContext?.surface,
              conversationType: options.silentReplyContext?.conversationType,
            },
          );
          // Emit onSkip for each dropped block so channels (e.g. Telegram) get a
          // signal that text was intentionally suppressed.
          for (const dropped of bufferedBlocks) {
            options.onSkip?.(dropped, { kind: "block", reason: "silent" });
          }
          bufferedBlocks.length = 0;
        }
        // Now route the NO_REPLY final through the legacy normalize path so its
        // existing handling (onSkip + debug log) still fires. normalize-reply
        // already drops exact-silent text, so deliver() is never called.
        const normalized = normalizeReplyPayloadInternal(payload, {
          responsePrefix: options.responsePrefix,
          responsePrefixContext: options.responsePrefixContext,
          responsePrefixContextProvider: options.responsePrefixContextProvider,
          transformReplyPayload: options.transformReplyPayload,
          onHeartbeatStrip: options.onHeartbeatStrip,
          onSkip: (reason) => options.onSkip?.(payload, { kind, reason }),
        });
        if (!normalized) {
          silentReplyLogger.debug("exact NO_REPLY final payload was skipped before delivery", {
            hasSessionKey: Boolean(options.silentReplyContext?.sessionKey),
            surface: options.silentReplyContext?.surface,
            conversationType: options.silentReplyContext?.conversationType,
          });
        }
        return false;
      }

      // Final is a real reply — flush buffered blocks, then deliver final.
      for (const buffered of bufferedBlocks) {
        dispatchNormalized("block", buffered);
      }
      bufferedBlocks.length = 0;
      // Fall through to legacy final-normalize path below.
    }

    const normalized = normalizeReplyPayloadInternal(payload, {
      responsePrefix: options.responsePrefix,
      responsePrefixContext: options.responsePrefixContext,
      responsePrefixContextProvider: options.responsePrefixContextProvider,
      transformReplyPayload: options.transformReplyPayload,
      onHeartbeatStrip: options.onHeartbeatStrip,
      onSkip: (reason) => options.onSkip?.(payload, { kind, reason }),
    });
    if (!normalized) {
      if (kind === "final" && originalWasExactSilent) {
        silentReplyLogger.debug("exact NO_REPLY final payload was skipped before delivery", {
          hasSessionKey: Boolean(options.silentReplyContext?.sessionKey),
          surface: options.silentReplyContext?.surface,
          conversationType: options.silentReplyContext?.conversationType,
        });
      }
      return false;
    }

    dispatchNormalized(kind, normalized);
    return true;
  };

  /**
   * Defensive flush of any blocks that were buffered but never paired with a
   * final. In a well-behaved turn `final` always arrives, but if the model
   * stream tears down without emitting a final block, those buffered blocks
   * would otherwise be dropped silently. Flush them on markComplete so the
   * user still sees the reasoning that was already on its way.
   */
  const flushBufferedBlocksOnComplete = () => {
    if (bufferedBlocks.length === 0) {
      return;
    }
    silentReplyLogger.debug("flushing buffered blocks at markComplete (no final arrived)", {
      bufferedBlockCount: bufferedBlocks.length,
      hasSessionKey: Boolean(options.silentReplyContext?.sessionKey),
      surface: options.silentReplyContext?.surface,
    });
    for (const buffered of bufferedBlocks) {
      dispatchNormalized("block", buffered);
    }
    bufferedBlocks.length = 0;
  };

  const markComplete = () => {
    if (completeCalled) {
      return;
    }
    completeCalled = true;
    // Defensive: flush any buffered blocks that never saw a paired final.
    flushBufferedBlocksOnComplete();
    // If no replies were enqueued (pending is still 1 = just the reservation),
    // schedule clearing the reservation after current microtasks complete.
    // This gives any in-flight enqueue() calls a chance to increment pending.
    void Promise.resolve().then(() => {
      if (pending === 1 && completeCalled) {
        // Still just the reservation, no replies were enqueued
        pending -= 1;
        if (pending === 0) {
          unregister();
          options.onIdle?.();
        }
      }
    });
  };

  return {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    getCancelledCounts: () => ({ ...cancelledCounts }),
    getFailedCounts: () => ({ ...failedCounts }),
    markComplete,
  };
}

export async function waitForReplyDispatcherIdle(
  dispatcher: Pick<ReplyDispatcher, "waitForIdle">,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!abortSignal) {
    await dispatcher.waitForIdle();
    return;
  }
  if (abortSignal.aborted) {
    return;
  }
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    abortSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([dispatcher.waitForIdle(), aborted]);
  } finally {
    removeAbortListener?.();
  }
}

export function createReplyDispatcherWithTyping(
  options: ReplyDispatcherWithTypingOptions,
): ReplyDispatcherWithTypingResult {
  const { typingCallbacks, onReplyStart, onIdle, onCleanup, ...dispatcherOptions } = options;
  const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
  const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
  const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;
  let typingController: TypingController | undefined;
  const dispatcher = createReplyDispatcher({
    ...dispatcherOptions,
    onIdle: () => {
      typingController?.markDispatchIdle();
      resolvedOnIdle?.();
    },
  });

  return {
    dispatcher,
    replyOptions: {
      onReplyStart: resolvedOnReplyStart,
      onTypingCleanup: resolvedOnCleanup,
      onTypingController: (typing) => {
        typingController = typing;
      },
    },
    markDispatchIdle: () => {
      typingController?.markDispatchIdle();
      resolvedOnIdle?.();
    },
    markRunComplete: () => {
      typingController?.markRunComplete();
    },
  };
}
