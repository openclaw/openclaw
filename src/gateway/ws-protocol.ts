export interface FrameLimits {
  maxFrameSize: number;
  maxMessageSize: number;
  maxQueueSize: number;
  maxFramesPerSecond: number;
  maxMessagesPerSecond: number;
}

export const DEFAULT_FRAME_LIMITS: FrameLimits = {
  maxFrameSize: 16 * 1024,
  maxMessageSize: 1024 * 1024,
  maxQueueSize: 100,
  maxFramesPerSecond: 1000,
  maxMessagesPerSecond: 500,
};

export interface RateLimiterState {
  frameCount: number;
  messageCount: number;
  windowStart: number;
}

export function createRateLimiterState(): RateLimiterState {
  return {
    frameCount: 0,
    messageCount: 0,
    windowStart: Date.now(),
  };
}

export function checkRateLimit(
  state: RateLimiterState,
  limits: FrameLimits,
): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  const windowElapsed = now - state.windowStart;

  if (windowElapsed >= 1000) {
    state.frameCount = 0;
    state.messageCount = 0;
    state.windowStart = now;
    return { ok: true };
  }

  if (state.frameCount >= limits.maxFramesPerSecond) {
    return { ok: false, reason: "frame rate limit exceeded" };
  }

  if (state.messageCount >= limits.maxMessagesPerSecond) {
    return { ok: false, reason: "message rate limit exceeded" };
  }

  state.frameCount++;
  state.messageCount++;

  return { ok: true };
}
