import type { ReplyPayload } from "./types.js";

export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    return replyResult;
  }

  const hasContent = (p: ReplyPayload): boolean =>
    !!(p.text || p.mediaUrl || (p.mediaUrls && p.mediaUrls.length > 0));

  // First pass: prefer non-error payloads (agent's actual reply).
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload || payload.isError) {
      continue;
    }
    if (hasContent(payload)) {
      return payload;
    }
  }

  // Fallback: return the last error payload if no non-error payload exists.
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (hasContent(payload)) {
      return payload;
    }
  }
  return undefined;
}
