// Shared streaming chunk buffer for gateway HTTP endpoints.
// Accumulates small text deltas and flushes them in configurable-sized chunks
// to reduce SSE overhead.
import type { GatewayHttpStreamingConfig } from "../config/types.gateway.js";

const DEFAULT_STREAMING_IDLE_MS = 500;

export type SseChunkBufferFlush = (text: string) => void;

export type SseChunkBuffer = {
  push(delta: string): void;
  flush(): boolean;
  length: number;
  destroy(): void;
};

export function createSseChunkBuffer(
  flush: SseChunkBufferFlush,
  config: GatewayHttpStreamingConfig | undefined,
): SseChunkBuffer {
  const minChars = Math.max(1, Math.floor(config?.minChars ?? 200));
  const maxChars =
    config?.maxChars !== undefined
      ? Math.max(minChars, Math.floor(config.maxChars))
      : minChars;
  const idleMs = Math.max(0, Math.floor(config?.idleMs ?? DEFAULT_STREAMING_IDLE_MS));

  const bufferingEnabled = maxChars > minChars;

  let buffered = "";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const scheduleIdleFlush = () => {
    if (destroyed || idleMs <= 0) { return; }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      if (!destroyed && buffered.length >= minChars) {
        const snap = buffered;
        buffered = "";
        flush(snap);
      }
    }, idleMs);
  };

  const maybeFlush = () => {
    if (buffered.length >= maxChars) {
      const snap = buffered;
      buffered = "";
      flush(snap);
    }
  };

  return {
    get length() {
      return buffered.length;
    },
    push(delta) {
      if (!delta) { return; }
      if (bufferingEnabled) {
        buffered += delta;
        maybeFlush();
        scheduleIdleFlush();
      } else {
        flush(delta);
      }
    },
    flush(): boolean {
      if (!buffered.length) { return false; }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      const snap = buffered;
      buffered = "";
      flush(snap);
      return true;
    },
    destroy() {
      destroyed = true;
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
    },
  };
}
