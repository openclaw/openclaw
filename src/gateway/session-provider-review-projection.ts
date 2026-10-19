import type { SessionProviderReviewProjection } from "../../packages/gateway-protocol/src/schema/sessions-provider-review.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { canContinueSessionProviderReview } from "../sessions/provider-review.js";

export function projectSessionProviderReview(
  entry: Pick<SessionEntry, "sessionId" | "providerReview"> | undefined,
  sessionKey: string,
): SessionProviderReviewProjection | undefined {
  const review = entry?.providerReview;
  if (!review || review.sessionId !== entry?.sessionId) {
    return undefined;
  }
  const canContinue = canContinueSessionProviderReview(review, sessionKey);
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
