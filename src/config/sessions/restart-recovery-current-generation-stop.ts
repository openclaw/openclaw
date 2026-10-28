import { normalizeOptionalString as normalizeRunId } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

/**
 * A stop or supersede in this generation leaves `abortedLastRun` beside a live
 * delivery claim, with a killed outcome or none yet when the stop flag lands first.
 * Without a restart mark or a fence from an earlier generation, that claim did not
 * outlive its process and is not restart-interrupted work (openclaw#1468).
 */
export function isMainSessionCurrentGenerationStop(
  entry: SessionEntry & Pick<InternalSessionEntry, "mainRestartRecovery">,
  lifecycleGeneration: string,
): boolean {
  return (
    (entry.status === "killed" || entry.status === undefined) &&
    entry.mainRestartRecovery === undefined &&
    entry.restartRecoveryRuns?.some((run) => run.lifecycleGeneration !== lifecycleGeneration) !==
      true
  );
}

/** A new turn may retire an aborted claim only when restart recovery will not resume it. */
export function canReplaceAbortedRestartRecoveryClaim(
  entry: SessionEntry,
  isMainRecoveryCandidate: boolean,
  admissionRunId: string | undefined,
  lifecycleGeneration: string,
): boolean {
  const activeClaimRunId = normalizeRunId(entry.restartRecoveryDeliveryRunId);
  return Boolean(
    admissionRunId &&
    activeClaimRunId &&
    admissionRunId !== activeClaimRunId &&
    entry.abortedLastRun === true &&
    entry.pendingFinalDelivery === undefined &&
    entry.restartRecoveryBeforeAgentReplyState === undefined &&
    entry.restartRecoveryDeliveryReceiptState === undefined &&
    // Session recovery resumes its claims before new input. Other lifecycle owners
    // must be able to replace an interrupted claim when admitting a new turn.
    (((entry.status === undefined || entry.status === "interrupted") &&
      (entry.restartRecoverySourceIngress === "control-ui" || !isMainRecoveryCandidate)) ||
      isMainSessionCurrentGenerationStop(entry, lifecycleGeneration)),
  );
}
