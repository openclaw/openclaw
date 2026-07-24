import {
  acceptLogicalTurnInTransaction,
  claimLogicalTurnAttempt,
  finishLogicalTurnAttempt,
  renewLogicalTurnAttempt,
  type LogicalTurnIngressKind,
} from "../../agents/logical-turn-store.js";
import type {
  PersistedUserTurnMessage,
  UserTurnLogicalAdmission,
} from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";

export type LogicalTurnAdmissionController = UserTurnLogicalAdmission;

const DEFAULT_ATTEMPT_LEASE_MS = 10 * 60 * 1_000;

function readIdempotencyKey(message: PersistedUserTurnMessage): string | undefined {
  const value = (message as unknown as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Shared durable turn admission for first-party chat and Telegram ingress.
 * It augments the existing transcript/adoption owners; it does not replay work.
 */
export function createLogicalTurnAdmission(params: {
  agentId: string;
  ingressKind: LogicalTurnIngressKind;
  ingressKey: string;
  leaseDurationMs?: number;
}): LogicalTurnAdmissionController {
  const ingressKey = params.ingressKey.trim();
  if (!ingressKey) {
    throw new Error("logical turn admission requires a stable ingress key");
  }
  const logicalTurnId = `${params.ingressKind}:${ingressKey}`;
  const databaseOptions: OpenClawAgentDatabaseOptions = { agentId: params.agentId };
  const leaseDurationMs = params.leaseDurationMs ?? DEFAULT_ATTEMPT_LEASE_MS;
  let accepted = false;
  let claimed: { attemptEpoch: number; ownerId: string } | undefined;
  let renewalTimer: NodeJS.Timeout | undefined;

  const stopRenewal = () => {
    if (renewalTimer) {
      clearInterval(renewalTimer);
      renewalTimer = undefined;
    }
  };

  return {
    acceptInTranscriptTransaction: (context) => {
      const persistedKey = readIdempotencyKey(context.message);
      if (persistedKey !== ingressKey) {
        throw new Error(`logical turn ingress key did not match persisted user event`);
      }
      acceptLogicalTurnInTransaction(context.database, {
        logicalTurnId,
        ingressKind: params.ingressKind,
        ingressKey,
        sessionId: context.sessionId,
        sessionKey: context.sessionKey,
        userEventId: context.messageId,
      });
      accepted = true;
    },
    claimAttempt: (ownerId) => {
      if (!accepted) {
        return { claimed: false, reason: "missing-turn" };
      }
      const result = claimLogicalTurnAttempt(databaseOptions, {
        logicalTurnId,
        ownerId,
        leaseDurationMs,
      });
      if (result.claimed) {
        claimed = { attemptEpoch: result.attemptEpoch, ownerId };
        stopRenewal();
        renewalTimer = setInterval(
          () => {
            if (!claimed) {
              stopRenewal();
              return;
            }
            try {
              const renewed = renewLogicalTurnAttempt(databaseOptions, {
                logicalTurnId,
                attemptEpoch: claimed.attemptEpoch,
                ownerId: claimed.ownerId,
                leaseDurationMs,
              });
              if (!renewed) {
                stopRenewal();
              }
            } catch {
              stopRenewal();
            }
          },
          Math.max(1_000, Math.floor(leaseDurationMs / 3)),
        );
        renewalTimer.unref();
      }
      return result;
    },
    finishAttempt: ({ outcome, terminal }) => {
      if (!claimed) {
        return false;
      }
      const finishingClaim = claimed;
      stopRenewal();
      claimed = undefined;
      return finishLogicalTurnAttempt(databaseOptions, {
        logicalTurnId,
        attemptEpoch: finishingClaim.attemptEpoch,
        ownerId: finishingClaim.ownerId,
        outcome,
        terminal,
      });
    },
  };
}
