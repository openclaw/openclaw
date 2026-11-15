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
      cleanupAgentTurnAdmission(params);
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

/** Release failed preparation. */
export function cleanupAgentTurnAdmission({
  cleanupRunAbort,
  releaseGatewayAdmission,
}: {
  cleanupRunAbort?: () => void;
  releaseGatewayAdmission: () => void;
}) {
  cleanupRunAbort?.();
  releaseGatewayAdmission();
}
