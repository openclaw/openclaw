/** Local RPC budget for preparing image attachments and receiving chat.send's initial ACK. */
export const DEFAULT_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Resolve an explicit UI override without changing the Gateway's agent-run timeout. */
export function resolveImageAttachmentRequestTimeoutMs(
  configuredTimeoutMs?: number | null,
): number {
  if (configuredTimeoutMs == null) {
    return DEFAULT_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS;
  }
  const timeoutMs = Math.floor(configuredTimeoutMs);
  if (!Number.isFinite(configuredTimeoutMs) || timeoutMs < 1) {
    return DEFAULT_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS;
  }
  return Math.min(timeoutMs, 2_147_483_647);
}
