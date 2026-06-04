/** Typing indicator lifecycle controller for reply runs. */
import {
  finiteSecondsToTimerSafeMilliseconds,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createTypingKeepaliveLoop } from "../../channels/typing-lifecycle.js";
import { createTypingStartGuard } from "../../channels/typing-start-guard.js";
import { isSilentReplyPrefixText, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

const DEFAULT_TYPING_INTERVAL_SECONDS = 6;
const DEFAULT_TYPING_TTL_MS = 2 * 60_000;
export const VISIBLE_DELIVERY_TYPING_START_TIMEOUT_MS = 1000;

export async function runVisibleDeliveryTypingStart(params: {
  start: () => Promise<void> | void;
  timeoutMs?: number;
  log?: (message: string) => void;
}): Promise<void> {
  const timeoutMs = resolveTimerTimeoutMs(
    params.timeoutMs,
    VISIBLE_DELIVERY_TYPING_START_TIMEOUT_MS,
    0,
  );
  const start = Promise.resolve()
    .then(() => params.start())
    .catch((error: unknown) => {
      params.log?.(`visible-delivery typing start failed: ${String(error)}`);
    });
  if (timeoutMs <= 0) {
    await start;
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  // Typing feedback is UX-only. Wait briefly for the first platform presence
  // update, but never make message delivery depend on a stalled channel API.
  const result = await Promise.race([start.then(() => "done" as const), timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  if (result === "timeout") {
    params.log?.(
      `visible-delivery typing start timed out after ${timeoutMs}ms; continuing delivery`,
    );
  }
}

function resolveTypingIntervalMs(seconds: number | undefined): number {
  if (Number.isFinite(seconds) && (seconds ?? 0) <= 0) {
    return 0;
  }
  return (
    finiteSecondsToTimerSafeMilliseconds(seconds ?? DEFAULT_TYPING_INTERVAL_SECONDS) ??
    DEFAULT_TYPING_INTERVAL_SECONDS * 1000
  );
}

/** Controller for channel typing indicator lifecycle during a reply run. */
export type TypingController = {
  onReplyStart: () => Promise<void>;
  startTypingLoop: () => Promise<void>;
  startTypingForVisibleDelivery: () => Promise<void>;
  startTypingOnText: (text?: string) => Promise<void>;
  refreshTypingTtl: () => void;
  isActive: () => boolean;
  markRunComplete: () => void;
  markDispatchIdle: () => void;
  cleanup: () => void;
};

/** Creates a typing controller that seals itself after run and dispatch completion. */
export function createTypingController(params: {
  onReplyStart?: () => Promise<void> | void;
  onCleanup?: () => void;
  typingIntervalSeconds?: number;
  typingTtlMs?: number;
  silentToken?: string;
  log?: (message: string) => void;
}): TypingController {
  const { onReplyStart, onCleanup, silentToken = SILENT_REPLY_TOKEN, log } = params;
  if (!onReplyStart && !onCleanup) {
    return {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingForVisibleDelivery: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: () => {},
    };
  }
  let started = false;
  let active = false;
  let runComplete = false;
  let dispatchIdle = false;
  let triggerInFlight = false;
  // Important: callbacks (tool/block streaming) can fire late (after the run completed),
  // especially when upstream event emitters don't await async listeners.
  // Once we stop typing, we "seal" the controller so late events can't restart typing forever.
  let sealed = false;
  let typingTtlTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs = resolveTypingIntervalMs(params.typingIntervalSeconds);
  const typingTtlMs = resolveTimerTimeoutMs(params.typingTtlMs, DEFAULT_TYPING_TTL_MS, 0);

  const formatTypingTtl = (ms: number) => {
    if (ms % 60_000 === 0) {
      return `${ms / 60_000}m`;
    }
    return `${Math.round(ms / 1000)}s`;
  };

  const resetCycle = () => {
    started = false;
    active = false;
    runComplete = false;
    dispatchIdle = false;
  };

  const cleanup = () => {
    if (sealed) {
      return;
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
      typingTtlTimer = undefined;
    }
    if (dispatchIdleTimer) {
      clearTimeout(dispatchIdleTimer);
      dispatchIdleTimer = undefined;
    }
    typingLoop.stop();
    // Notify the channel to stop its typing indicator (e.g., on NO_REPLY).
    // This fires only once (sealed prevents re-entry).
    if (active) {
      onCleanup?.();
    }
    resetCycle();
    sealed = true;
  };

  const refreshTypingTtl = () => {
    if (sealed) {
      return;
    }
    if (!typingIntervalMs || typingIntervalMs <= 0) {
      return;
    }
    if (typingTtlMs <= 0) {
      return;
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
    }
    typingTtlTimer = setTimeout(() => {
      if (!typingLoop.isRunning()) {
        return;
      }
      log?.(`typing TTL reached (${formatTypingTtl(typingTtlMs)}); stopping typing indicator`);
      cleanup();
    }, typingTtlMs);
  };

  const isActive = () => active && !sealed;

  const startGuard = createTypingStartGuard({
    isSealed: () => sealed,
    shouldBlock: () => runComplete,
    rethrowOnError: true,
  });

  const triggerTyping = async (options?: { allowAfterRunComplete?: boolean }) => {
    if (triggerInFlight) {
      return;
    }
    triggerInFlight = true;
    try {
      const run = async () => {
        await onReplyStart?.();
        refreshTypingTtl();
      };
      if (options?.allowAfterRunComplete === true) {
        if (!sealed) {
          await run();
        }
      } else {
        await startGuard.run(run);
      }
    } catch (err) {
      log?.(`typing start failed: ${String(err)}`);
    } finally {
      triggerInFlight = false;
    }
  };

  const scheduleTyping = async (options?: { allowAfterRunComplete?: boolean }) => {
    if (options?.allowAfterRunComplete === true) {
      await triggerTyping(options);
      return;
    }
    void triggerTyping(options);
    await Promise.resolve();
  };

  const typingLoop = createTypingKeepaliveLoop({
    intervalMs: typingIntervalMs,
    onTick: triggerTyping,
  });

  const ensureStart = async (options?: { allowAfterRunComplete?: boolean }) => {
    if (sealed) {
      return;
    }
    // Late callbacks after a run completed should never restart typing.
    if (runComplete && options?.allowAfterRunComplete !== true) {
      return;
    }
    if (!active) {
      active = true;
    }
    if (started) {
      return;
    }
    started = true;
    await scheduleTyping(options);
  };

  const maybeStopOnIdle = () => {
    if (!active) {
      return;
    }
    // Stop only when the model run is done and the dispatcher queue is empty.
    if (runComplete && dispatchIdle) {
      cleanup();
    }
  };

  const startTypingLoop = async () => {
    if (sealed) {
      return;
    }
    if (runComplete) {
      return;
    }
    // Always refresh TTL when called, even if loop already running.
    // This keeps typing alive during long tool executions.
    refreshTypingTtl();
    if (!onReplyStart) {
      return;
    }
    if (typingLoop.isRunning()) {
      return;
    }
    await ensureStart();
    typingLoop.start();
  };

  const startTypingForVisibleDelivery = async () => {
    if (sealed) {
      return;
    }
    if (!onReplyStart || typingLoop.isRunning()) {
      return;
    }
    if (runComplete && dispatchIdle) {
      if (started) {
        return;
      }
      started = true;
      await triggerTyping({ allowAfterRunComplete: true });
      return;
    }
    refreshTypingTtl();
    // Visible delivery is owned by the dispatcher and may happen after the
    // model run is complete; keep the stream-event late-start guard separate.
    await ensureStart({ allowAfterRunComplete: true });
    typingLoop.start();
  };

  const startTypingOnText = async (text?: string) => {
    if (sealed) {
      return;
    }
    const trimmed = normalizeOptionalString(text);
    if (!trimmed) {
      return;
    }
    if (
      silentToken &&
      (isSilentReplyText(trimmed, silentToken) || isSilentReplyPrefixText(trimmed, silentToken))
    ) {
      return;
    }
    // Visible text, not silent control tokens, is what should start typing.
    refreshTypingTtl();
    await startTypingLoop();
  };

  let dispatchIdleTimer: NodeJS.Timeout | undefined;
  const DISPATCH_IDLE_GRACE_MS = 10_000;

  const markRunComplete = () => {
    runComplete = true;
    maybeStopOnIdle();
    if (!sealed && !dispatchIdle) {
      // Dispatcher idle is the normal cleanup signal; this fallback prevents leaked typing.
      dispatchIdleTimer = setTimeout(() => {
        if (!sealed && !dispatchIdle) {
          log?.("typing: dispatch idle not received after run complete; forcing cleanup");
          cleanup();
        }
      }, DISPATCH_IDLE_GRACE_MS);
    }
  };

  const markDispatchIdle = () => {
    dispatchIdle = true;
    if (dispatchIdleTimer) {
      clearTimeout(dispatchIdleTimer);
      dispatchIdleTimer = undefined;
    }
    maybeStopOnIdle();
  };

  return {
    onReplyStart: ensureStart,
    startTypingLoop,
    startTypingForVisibleDelivery,
    startTypingOnText,
    refreshTypingTtl,
    isActive,
    markRunComplete,
    markDispatchIdle,
    cleanup,
  };
}
