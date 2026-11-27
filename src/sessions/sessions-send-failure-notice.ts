export function formatSessionsSendDeliveryFailureNotice(params: {
  displayKey: string;
  error?: string;
  sourceReplyDelivered?: boolean;
}): string {
  const error = params.error?.trim() ? `: ${params.error.trim()}` : "";
  return params.sourceReplyDelivered
    ? `sessions_send target run for ${params.displayKey} failed${error}. The target's final reply was already delivered to its source conversation. Do not resend; report the run failure.`
    : `sessions_send delivery to ${params.displayKey} failed${error}. The target may not have received the message; retry or report the failure instead of assuming delivery succeeded.`;
}

const LEGACY_SESSIONS_SEND_DELIVERY_FAILURE_RE =
  /^sessions_send delivery to [^\r\n]+ failed(?:: [\s\S]+)?\. The target may not have received the message; retry or report the failure instead of assuming delivery succeeded\.$/u;
const LEGACY_SESSIONS_SEND_TARGET_RUN_FAILURE_RE =
  /^sessions_send target run for [^\r\n]+ failed(?:: [\s\S]+)?\. The target's final reply was already delivered to its source conversation\. Do not resend; report the run failure\.$/u;

/** Released failure wakes have no display marker; recognize only complete producer notices. */
export function isLegacySessionsSendFailureNoticeText(text: string): boolean {
  const trimmed = text.trim();
  return (
    LEGACY_SESSIONS_SEND_DELIVERY_FAILURE_RE.test(trimmed) ||
    LEGACY_SESSIONS_SEND_TARGET_RUN_FAILURE_RE.test(trimmed)
  );
}
