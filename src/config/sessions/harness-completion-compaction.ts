import { isDeepStrictEqual } from "node:util";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type { SessionAdmissionTransition } from "./session-admission-transition.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Only the requester incarnation advances; task, source and requester scope stay exact. */
export function advanceHarnessCompletionClaim(
  claim: HarnessCompletionRecovery | undefined,
  transition: SessionAdmissionTransition,
): HarnessCompletionRecovery | undefined {
  if (
    !claim ||
    !transition.previous ||
    claim.sessionId !== transition.previous.sessionId ||
    claim.lifecycleRevision !== transition.previous.lifecycleRevision
  ) {
    return undefined;
  }
  const { lifecycleRevision: _previousRevision, ...source } = claim;
  return {
    ...source,
    sessionId: transition.current.sessionId,
    ...(transition.current.lifecycleRevision !== undefined
      ? { lifecycleRevision: transition.current.lifecycleRevision }
      : {}),
  };
}

function advanceRestartSource<T extends Pick<SessionEntry, "sessionId" | "lifecycleRevision">>(
  source: T | undefined,
  entry: SessionEntry,
  sessionId: string,
): T | undefined {
  return source?.sessionId === entry.sessionId &&
    source.lifecycleRevision === entry.lifecycleRevision
    ? { ...source, sessionId }
    : source;
}

/** Included in the same host-owned commit that replaces the compaction predecessor. */
export function projectRestartRecoveryCompaction(entry: SessionEntry, sessionId: string) {
  const claim = entry.restartRecoveryHarnessCompletion;
  const next = advanceHarnessCompletionClaim(claim, {
    previous: entry,
    current: { sessionId, lifecycleRevision: entry.lifecycleRevision },
  });
  return {
    restartRecoveryOperatorSource: advanceRestartSource(
      entry.restartRecoveryOperatorSource,
      entry,
      sessionId,
    ),
    restartRecoveryRequesterSource: advanceRestartSource(
      entry.restartRecoveryRequesterSource,
      entry,
      sessionId,
    ),
    ...(next ? { restartRecoveryHarnessCompletion: next } : {}),
    ...(next && entry.restartRecoveryTerminalDeliveryEvidence
      ? {
          restartRecoveryTerminalDeliveryEvidence:
            entry.restartRecoveryTerminalDeliveryEvidence.map((receipt) =>
              isDeepStrictEqual(receipt.harnessCompletion, claim)
                ? { ...receipt, harnessCompletion: next }
                : receipt,
            ),
        }
      : {}),
  };
}
