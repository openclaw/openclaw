import type { InternalSessionEntry } from "./types.js";

export type DurableQuestionRecoveryOwner = {
  questionId: string;
  sourceRunId: string;
  continuationRunId?: string;
  sessionId: string;
  lifecycleRevision: string;
};

/** A retained native reference must never lose its question exclusion proof. */
export function hasQuestionOwnerNativeReference(
  entry: InternalSessionEntry,
  owner: DurableQuestionRecoveryOwner,
): boolean {
  if (entry.sessionId !== owner.sessionId || entry.lifecycleRevision !== owner.lifecycleRevision) {
    return false;
  }
  const owned = new Set([owner.sourceRunId, owner.continuationRunId].filter(Boolean));
  const referenced = [
    entry.lifecycleRunId,
    entry.restartRecoveryDeliveryRunId,
    entry.restartRecoveryDeliverySourceRunId,
    entry.mainRestartRecovery?.reservation?.runId,
    ...Object.values(entry.mainRestartRecovery?.foregroundClaims?.runIdsByClaimId ?? {}),
    ...(entry.restartRecoveryRuns ?? []).map((run) => run.runId),
  ];
  // Prepared final output keeps its exact source claim until the delivery owner settles it.
  return referenced.some((runId) => runId !== undefined && owned.has(runId));
}
