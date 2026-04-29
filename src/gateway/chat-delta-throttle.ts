export const DEFAULT_CHAT_DELTA_THROTTLE_MS = 150;

/**
 * Resolve the gateway chat-delta broadcast throttle, in milliseconds.
 *
 * Reads `OPENCLAW_CHAT_DELTA_THROTTLE_MS` and falls back to
 * `DEFAULT_CHAT_DELTA_THROTTLE_MS` when the value is unset, empty,
 * non-numeric, NaN, or negative. Lower values trade more WebSocket frames
 * for smoother per-token rendering; `0` disables the throttle entirely.
 */
export function resolveChatDeltaThrottleMs(): number {
  const raw = process.env.OPENCLAW_CHAT_DELTA_THROTTLE_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_CHAT_DELTA_THROTTLE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CHAT_DELTA_THROTTLE_MS;
  }
  return parsed;
}
