import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { discardPreparedInboundMedia, type OffloadedRef } from "../chat-attachments.js";

/** Finish preparation custody after owner release, even when cleanup rejects. */
export async function finishAgentTurnPreparation(
  params: Parameters<typeof cleanupAgentTurnAdmission>[0] & {
    transferred: boolean;
    getOffloadedRefs: () => OffloadedRef[];
    clearUnaccepted: () => void;
    settleSourceWork: () => void;
  },
) {
  try {
    if (!params.transferred) {
      await cleanupAgentTurnAdmission(params);
    }
  } finally {
    try {
      // Persistence may transfer media while owner cleanup awaits; read custody afterward.
      await discardPreparedInboundMedia(params.getOffloadedRefs());
      params.clearUnaccepted();
    } finally {
      if (!params.transferred) {
        params.settleSourceWork();
      }
    }
  }
}

/** Release failed preparation in owner order before allowing restart recovery to wake. */
export async function cleanupAgentTurnAdmission({
  lease,
  cleanupRunAbort,
  releaseGatewayAdmission,
  releaseCronContinuation,
}: {
  lease?: MainSessionRecoveryOwnerLease;
  cleanupRunAbort?: () => void;
  releaseGatewayAdmission: () => void;
  releaseCronContinuation: () => Promise<boolean>;
}) {
  let pendingRecovery: Awaited<ReturnType<typeof releaseMainSessionRecoveryOwner>> = undefined;
  try {
    pendingRecovery = await releaseMainSessionRecoveryOwner(lease);
  } finally {
    try {
      cleanupRunAbort?.();
      releaseGatewayAdmission();
    } finally {
      try {
        await releaseCronContinuation();
      } finally {
        scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
      }
    }
  }
}
