import type { EventEmitter } from "node:events";

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
      if (settled) return;
      settled = true;
      cleanup();
      try {
        gateway?.disconnect?.();
      } finally {
        resolve();
      }
    };
    const finishReject = (err: unknown) => {
      if (settled) return;
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
