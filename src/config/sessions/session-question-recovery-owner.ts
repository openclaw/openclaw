import { isMainThread } from "node:worker_threads";
import type { InternalSessionEntry, InternalSessionEntry as SessionEntry } from "./types.js";

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

/** Alias relocation has no accepted owner for transferring durable native recovery fences. */
export function assertQuestionAliasRelocation(previous: SessionEntry | undefined): void {
  assertQuestionLifecycleWorker(previous);
  if (previous?.durableQuestionOwners?.length) {
    throw new Error("Alias relocation cannot transfer durable question recovery ownership.");
  }
}

/** Synchronous legacy and Doctor writes cannot retire worker-owned question custody. */
export function assertQuestionLifecycleWorker(previous: SessionEntry | undefined): void {
  if (isMainThread && previous?.durableQuestionOwners?.length) {
    throw new Error(
      "Durable question lifecycle changes require the owning session worker; use the asynchronous lifecycle writer.",
    );
  }
}
