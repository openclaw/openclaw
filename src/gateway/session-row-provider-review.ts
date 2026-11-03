import type { SessionEntry } from "../config/sessions.js";
import { canContinueSessionProviderReview } from "../sessions/provider-review.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/** Projects only the current session generation's provider review onto its row. */
export function projectSessionRowProviderReview(
  key: string,
  entry: SessionEntry | undefined,
): GatewaySessionRow["providerReview"] {
  const review = entry?.providerReview;
  if (!review || review.sessionId !== entry?.sessionId) {
    return undefined;
  }
  const canContinue = canContinueSessionProviderReview(review, key);
  return {
    id: review.id,
    runId: review.runId,
    ...(review.review ? { explanation: review.review.explanation } : {}),
    ...(canContinue && review.review?.continuation
      ? { continuationMessage: review.review.continuation.message }
      : {}),
    canContinue,
  };
}
