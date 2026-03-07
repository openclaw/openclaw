import type { RequestClient } from "@buape/carbon";
import { sendTyping } from "./typing.js";

const DEFAULT_INTERVAL_MS = 6000;

/**
 * Ref-counted typing indicator guard for Discord.
 *
 * While at least one acquire() is active, keeps the typing indicator alive
 * by sending periodic typing API calls. Discord auto-clears typing after
 * ~10 seconds, so the guard refreshes every 6 seconds by default.
 */
export function createTypingGuard(params: {
  rest: RequestClient;
  channelId: string;
  /** Refresh interval in ms. Default: 6000 (Discord clears after 10s). */
  intervalMs?: number;
  onError?: (err: unknown) => void;
  /** Called each time a typing signal is fired. */
  onFire?: () => void;
  /** Called when the guard is disposed (typing stops). */
  onDispose?: () => void;
}): {
  /** Increment ref count. Starts refresh loop on first acquire. */
  acquire: () => void;
  /** Decrement ref count. Stops refresh loop when count hits 0. */
  release: () => void;
  /** Send an immediate typing pulse (e.g. after a message send clears the indicator). */
  reinforce: () => void;
  /** Force-stop regardless of ref count. */
  dispose: () => void;
} {
  const intervalMs = params.intervalMs ?? DEFAULT_INTERVAL_MS;
  let refCount = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  function fire() {
    params.onFire?.();
    void sendTyping({ rest: params.rest, channelId: params.channelId }).catch((err) => {
      params.onError?.(err);
    });
  }

  function startLoop() {
    if (interval || disposed) {
      return;
    }
    fire();
    interval = setInterval(fire, intervalMs);
  }

  function stopLoop() {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  }

  return {
    acquire() {
      if (disposed) {
        return;
      }
      refCount += 1;
      if (refCount === 1) {
        startLoop();
      }
    },
    release() {
      if (disposed || refCount <= 0) {
        return;
      }
      refCount -= 1;
      if (refCount === 0) {
        stopLoop();
      }
    },
    reinforce() {
      if (disposed || refCount <= 0) {
        return;
      }
      fire();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      refCount = 0;
      stopLoop();
      params.onDispose?.();
    },
  };
}
