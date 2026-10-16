import { isDeepStrictEqual } from "node:util";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type { SessionAdmissionTransition } from "./session-admission-transition.types.js";
import type { SessionEntry } from "./types.js";

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

/** Included in the same host-owned commit that replaces the compaction predecessor. */
export function projectHarnessCompletionCompaction(entry: SessionEntry, sessionId: string) {
  const claim = entry.restartRecoveryHarnessCompletion;
  const next = advanceHarnessCompletionClaim(claim, {
    previous: entry,
    current: { sessionId, lifecycleRevision: entry.lifecycleRevision },
  });
  if (!next) {
    return {};
  }
  return {
    restartRecoveryHarnessCompletion: next,
    ...(entry.restartRecoveryTerminalDeliveryEvidence
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
