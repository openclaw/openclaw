import type { EventEmitter } from "node:events";

export type DiscordGatewayHandle = {
  emitter?: Pick<EventEmitter, "on" | "removeListener">;
  disconnect?: () => void;
};

export type WaitForDiscordGatewayStopParams = {
  gateway?: DiscordGatewayHandle;
  abortSignal?: AbortSignal;
  onGatewayError?: (err: unknown) => void;
  shouldStopOnError?: (err: unknown) => boolean;
  registerForceStop?: (forceStop: (err: unknown) => void) => void;
};

export function getDiscordGatewayEmitter(gateway?: unknown): EventEmitter | undefined {
  return (gateway as { emitter?: EventEmitter } | undefined)?.emitter;
}

export async function waitForDiscordGatewayStop(
  params: WaitForDiscordGatewayStopParams,
): Promise<void> {
  const { gateway, abortSignal, onGatewayError, shouldStopOnError } = params;
  const emitter = gateway?.emitter;
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      // Remove abort listener first, but keep the error listener alive across
      // gateway.disconnect() so Carbon's synchronous "max reconnect attempts"
      // error (emitted when maxAttempts=0 is set before shutdown) is absorbed
      // rather than crashing Node with an unhandled 'error' event.
      abortSignal?.removeEventListener("abort", onAbort);
      try {
        gateway?.disconnect?.();
      } finally {
        emitter?.removeListener("error", onGatewayErrorEvent);
        resolve();
      }
    };
    const finishReject = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal?.removeEventListener("abort", onAbort);
      try {
        gateway?.disconnect?.();
      } finally {
        emitter?.removeListener("error", onGatewayErrorEvent);
        reject(err);
      }
    };
    const onAbort = () => {
      finishResolve();
    };
    const onGatewayErrorEvent = (err: unknown) => {
      // If already settled (e.g. shutting down), absorb the error silently so
      // Carbon's reconnect-exhausted error during intentional disconnect does
      // not surface as an unhandled rejection or spurious onGatewayError call.
      if (settled) {
        return;
      }
      onGatewayError?.(err);
      const shouldStop = shouldStopOnError?.(err) ?? true;
      if (shouldStop) {
        finishReject(err);
      }
    };
    const onForceStop = (err: unknown) => {
      finishReject(err);
    };

    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    emitter?.on("error", onGatewayErrorEvent);
    params.registerForceStop?.(onForceStop);
  });
}
