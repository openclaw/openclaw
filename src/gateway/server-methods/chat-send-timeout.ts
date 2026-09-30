/** Default agent-run budget for image turns so visual analysis can finish. */
export const DEFAULT_IMAGE_CHAT_SEND_TIMEOUT_MS = 5 * 60_000;

/** Preserve caller intent and extend only image turns without an explicit budget. */
export function resolveChatSendTimeoutOverrideMs(params: {
  requestedTimeoutMs?: number;
  hasImageAttachment: boolean;
}): number | undefined {
  if (params.requestedTimeoutMs !== undefined) {
    return params.requestedTimeoutMs;
  }
  return params.hasImageAttachment ? DEFAULT_IMAGE_CHAT_SEND_TIMEOUT_MS : undefined;
}
