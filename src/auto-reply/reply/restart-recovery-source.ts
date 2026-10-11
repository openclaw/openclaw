import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildRestartRecoveryClaimCleanupPatch,
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "../../config/sessions/restart-recovery-state.js";
import { patchSessionEntryTarget } from "../../config/sessions/session-accessor.js";
import type { SessionEntryTargetPatchScope } from "../../config/sessions/session-accessor.types.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import {
  isTerminalSessionStatus,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions/types.js";

/** Provider redelivery guard shared by ingress and the agent admission boundary. */
export function isDuplicateRestartRecoverySource(
  entry: SessionEntry | null | undefined,
  sourceTurnId: unknown,
): boolean {
  const normalizedSourceTurnId = normalizeOptionalString(sourceTurnId);
  return Boolean(
    normalizedSourceTurnId &&
    (hasRestartRecoveryTerminalRun(entry ?? undefined, normalizedSourceTurnId) ||
      hasRestartRecoverySourceClaim(entry ?? undefined, normalizedSourceTurnId)),
  );
}

export async function retireTerminalRestartRecoverySourceClaim(params: {
  target: SessionEntryTargetPatchScope;
  assertCurrent: SessionSourceAssertion;
  sessionId: string;
  sourceTurnId: string;
}): Promise<SessionEntry | undefined> {
  let didRetire = false;
  const retired = await patchSessionEntryTarget(
    params.target,
    (current) => {
      if (
        current.sessionId !== params.sessionId ||
        !isTerminalSessionStatus(current.status) ||
        current.status === "interrupted" ||
        current.abortedLastRun === true ||
        current.restartRecoveryDeliveryReceiptState === "terminal-pending" ||
        !hasRestartRecoverySourceClaim(current, params.sourceTurnId)
      ) {
        return null;
      }
      didRetire = true;
      return {
        ...buildRestartRecoveryClaimCleanupPatch({
          entry: current,
          recordTerminalSource: true,
          terminalSourceRunId: params.sourceTurnId,
        }),
        updatedAt: Date.now(),
      };
    },
    {
      skipMaintenance: true,
      takeCacheOwnership: true,
      workerGuard: { source: params.assertCurrent },
    },
  );
  return didRetire ? (retired ?? undefined) : undefined;
}
