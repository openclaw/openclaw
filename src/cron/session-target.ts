const INVALID_CRON_SESSION_TARGET_ID_ERROR = "invalid cron sessionTarget session id";

export function assertSafeCronSessionTargetId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  if (trimmed.includes("\0")) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  // Encode path-separator characters so channel-native conversation IDs
  // that contain `/` (e.g. DingTalk base64 `cid.../wogxwy2a==`) or `\`
  // don't become path-traversal vectors when the cron run-log subsystem
  // derives filesystem paths from jobId. The encoding is reversible
  // (decodeURIComponent) so operators can still recover the original
  // sessionKey from a run-log filename when debugging (#64030).
  return trimmed.replaceAll("/", "%2F").replaceAll("\\", "%5C");
}
