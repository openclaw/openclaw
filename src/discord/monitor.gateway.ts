import type { EventEmitter } from "node:events";
import {
  clearRecoveringAndFlush,
  getQueuedCount,
  isRecovering,
  setRecovering,
} from "./recovery-state.js";

export type DiscordGatewayHandle = {
  emitter?: Pick<EventEmitter, "on" | "removeListener">;
  disconnect?: () => void;
};

export function getDiscordGatewayEmitter(gateway?: unknown): EventEmitter | undefined {
  return (gateway as { emitter?: EventEmitter } | undefined)?.emitter;
}

export async function waitForDiscordGatewayStop(params: {
  gateway?: DiscordGatewayHandle;
  abortSignal?: AbortSignal;
  onGatewayError?: (err: unknown) => void;
  shouldStopOnError?: (err: unknown) => boolean;
}): Promise<void> {
  const { gateway, abortSignal, onGatewayError, shouldStopOnError } = params;
  const emitter = gateway?.emitter;
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", onAbort);
      emitter?.removeListener("error", onGatewayErrorEvent);
    };
    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        gateway?.disconnect?.();
      } finally {
        resolve();
      }
    };
    const finishReject = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        gateway?.disconnect?.();
      } finally {
        reject(err);
      }
    };
    const onAbort = () => {
      finishResolve();
    };
    const onGatewayErrorEvent = (err: unknown) => {
      onGatewayError?.(err);
      const shouldStop = shouldStopOnError?.(err) ?? true;
      if (shouldStop) {
        finishReject(err);
      }
    };

    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    emitter?.on("error", onGatewayErrorEvent);
  });
}

const DISCORD_CLOSED_MARKER = "WebSocket connection closed";
const DISCORD_OPENED_MARKER = "WebSocket connection opened";

/**
 * Attach recovery handlers for transient disconnects (e.g. 1006).
 * On disconnect, marks account as recovering so outbound delivery queues.
 * On reconnect, flushes the queue.
 */
export function attachDiscordRecoveryHandlers(params: {
  emitter?: Pick<EventEmitter, "on" | "removeListener">;
  accountId: string;
  isShuttingDown?: () => boolean;
  onQueued?: (count: number) => void;
  onFlushed?: (count: number) => void;
}): () => void {
  const { emitter, accountId, isShuttingDown, onQueued, onFlushed } = params;
  if (!emitter) {
    return () => {};
  }

  const onDebug = (msg: unknown) => {
    const message = String(msg);
    if (isShuttingDown?.()) {
      return;
    }
    if (message.includes(DISCORD_CLOSED_MARKER)) {
      setRecovering(accountId);
      const count = getQueuedCount(accountId);
      if (count > 0) {
        onQueued?.(count);
      }
      return;
    }
    if (message.includes(DISCORD_OPENED_MARKER) && isRecovering(accountId)) {
      void clearRecoveringAndFlush(accountId).then((flushed) => {
        if (flushed > 0) {
          onFlushed?.(flushed);
        }
      });
    }
  };

  emitter.on("debug", onDebug);
  return () => {
    emitter.removeListener("debug", onDebug);
  };
}
