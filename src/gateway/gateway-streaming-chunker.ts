// Shared streaming chunk buffer for gateway HTTP endpoints.
// Accumulates small text deltas and flushes them in configurable-sized chunks
// to reduce SSE overhead.
import type { GatewayHttpStreamingConfig } from "../config/types.gateway.js";

const DEFAULT_STREAMING_MIN_CHARS = 200;
const DEFAULT_STREAMING_MAX_CHARS = 800;
const DEFAULT_STREAMING_IDLE_MS = 500;

export type SseChunkBufferFlush = (text: string) => void;

export type SseChunkBuffer = {
  push(delta: string): void;
  flush(): boolean;
  length: number;
  destroy(): void;
};

function createPassthroughBuffer(flush: SseChunkBufferFlush): SseChunkBuffer {
  let destroyed = false;
  return {
    get length() { return 0; },
    push(delta) {
      if (!delta || destroyed) { return; }
      flush(delta);
    },
    flush() { return false; },
    destroy() { destroyed = true; },
  };
}

export function createSseChunkBuffer(
  flush: SseChunkBufferFlush,
  config: GatewayHttpStreamingConfig | undefined,
): SseChunkBuffer {
  // When no streaming config is provided, operate in pass-through mode
  // to preserve existing behavior. No buffering, no idle timers.
  if (!config) {
    return createPassthroughBuffer(flush);
  }

  const minChars = Math.max(1, Math.floor(config.minChars ?? DEFAULT_STREAMING_MIN_CHARS));
  const maxChars = Math.max(minChars, Math.floor(config.maxChars ?? DEFAULT_STREAMING_MAX_CHARS));
  const idleMs = Math.max(0, Math.floor(config.idleMs ?? DEFAULT_STREAMING_IDLE_MS));

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
      if (!destroyed && buffered.length > 0) {
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
