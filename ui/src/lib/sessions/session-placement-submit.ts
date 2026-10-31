import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "./session-capability.ts";
import {
  pauseSessionPlacementRecovery,
  readSessionPlacementRecovery,
  type SessionPlacementRecovery,
  type SessionPlacementStartMode,
  type SessionPlacementPendingRecovery,
  type SessionPlacementPausedRecovery,
  writeSessionPlacementRecovery,
  writeSessionPlacementRecoveryIfAvailable,
} from "./session-placement-recovery.ts";
import {
  deleteSessionPlacementDraft,
  startSessionPlacementInitialTurn,
} from "./session-placement-startup.ts";

export type SessionPlacementDraftAdvanceResult =
  | { status: "started"; messageId: string }
  | { status: "pending"; recovery: SessionPlacementPendingRecovery; retryAfterMs: number }
  | { status: "paused"; recovery: SessionPlacementPausedRecovery }
  | { status: "cancelled"; cleanupError?: string }
  | { status: "interrupted" }
  | { status: "ownership-lost" };

type SessionPlacementRecoveryRetirement = "resolved" | "interrupted";

export async function advanceSessionPlacementDraft(params: {
  client: Pick<GatewayBrowserClient, "request">;
  describe: SessionCapability["describe"];
  recovery: SessionPlacementRecovery;
  persistRecovery?: boolean;
  cleanupOnCancellation: () => boolean;
  mode: SessionPlacementStartMode;
  isLifecycleCurrent: () => boolean;
  ownsRecovery: () => boolean;
  clearRecovery: (retirement: SessionPlacementRecoveryRetirement) => void;
  setRecoveryPhase: (phase: "sending", durable: boolean, sessionId: string) => void;
  signal?: AbortSignal;
}): Promise<SessionPlacementDraftAdvanceResult> {
  const persistRecovery = params.persistRecovery !== false;
  const recovering = params.mode !== "dispatch";
  let recovery = params.recovery;
  const resending = recovery.phase === "sending";
  const pause = (
    error: string,
    reason: SessionPlacementPausedRecovery["reason"] = "not-sent",
  ): SessionPlacementDraftAdvanceResult => ({
    status: "paused",
    recovery: pauseSessionPlacementRecovery(recovery, error, persistRecovery, reason).recovery,
  });
  // Dispatch and send require both fences. After accepted delivery, inspect
  // them separately so lifecycle interruption is not reported as takeover.
  const isCurrentOwner = () => params.isLifecycleCurrent() && params.ownsRecovery();
  const deleteDraft = async (recovered = recovering) => {
    const error = await deleteSessionPlacementDraft(
      params,
      recovery.sessionKey,
      recovery.agentId,
      recovered,
    );
    if (!error) {
      params.clearRecovery("resolved");
    }
    return error;
  };
  if (recovery.phase === "paused") {
    return { status: "paused", recovery };
  }
  const existingRecovery =
    recovering && !resending && persistRecovery
      ? readSessionPlacementRecovery(
          recovery.gatewayUrl,
          recovery.recoveryScope,
          recovery.sessionKey,
        )
      : null;
  const ensureRecovery = () =>
    resending
      ? true
      : recovering
        ? existingRecovery?.messageId === recovery.messageId
        : writeSessionPlacementRecoveryIfAvailable(recovery);
  if (!isCurrentOwner()) {
    if (!params.cleanupOnCancellation()) {
      return { status: "interrupted" };
    }
    if (persistRecovery) {
      ensureRecovery();
    }
    const cleanupError = await deleteDraft();
    return { status: "cancelled", cleanupError };
  }
  const recoveryPersisted = !persistRecovery || ensureRecovery();
  if (!isCurrentOwner() || !recoveryPersisted) {
    if (!params.cleanupOnCancellation() && !isCurrentOwner()) {
      return { status: "interrupted" };
    }
    if (recovering && !recoveryPersisted) {
      return {
        status: "cancelled",
        cleanupError: "placement recovery storage is unavailable",
      };
    }
    const cleanupError = await deleteDraft();
    return { status: "cancelled", cleanupError };
  }

  const placementStart = await startSessionPlacementInitialTurn(
    params,
    {
      key: recovery.sessionKey,
      sessionId: recovery.sessionId,
      agentId: recovery.agentId,
      target: recovery.target,
      message: recovery.message,
      mentions: recovery.mentions,
      attachments: recovery.attachments,
      messageId: recovery.messageId,
      mode: resending ? "resend" : params.mode,
      cleanupOnCancellation: params.cleanupOnCancellation,
      signal: params.signal,
    },
    isCurrentOwner,
    (sessionId) => {
      recovery = { ...recovery, sessionId };
      let persisted = true;
      if (persistRecovery && !resending) {
        const currentRecovery = readSessionPlacementRecovery(
          recovery.gatewayUrl,
          recovery.recoveryScope,
          recovery.sessionKey,
        );
        if (currentRecovery && currentRecovery.messageId !== recovery.messageId) {
          return false;
        }
        persisted = writeSessionPlacementRecovery({ ...recovery, phase: "sending" });
      }
      if (persisted) {
        params.setRecoveryPhase("sending", persistRecovery, sessionId);
      }
      return persisted;
    },
  );
  if (!params.cleanupOnCancellation() && !isCurrentOwner()) {
    return { status: "interrupted" };
  }
  if (placementStart.status === "interrupted") {
    return placementStart;
  }
  if (placementStart.status === "cancelled") {
    const cleanupError = await deleteDraft(false);
    return { status: "cancelled", cleanupError };
  }
  if (placementStart.status === "session-missing") {
    params.clearRecovery("resolved");
    return { status: "cancelled" };
  }
  if (placementStart.status === "send-rejected") {
    return {
      status: "pending",
      recovery: { ...recovery, phase: "sending" },
      retryAfterMs: placementStart.retryAfterMs,
    };
  }
  if ("error" in placementStart) {
    return pause(
      placementStart.error,
      placementStart.status === "send-not-started"
        ? "not-sent"
        : placementStart.status === "send-definitive-rejected"
          ? "rejected"
          : "not-sent",
    );
  }
  if (!params.isLifecycleCurrent()) {
    // The page recorded why its lifecycle changed before this accepted send returned.
    // Retire the delivered recovery without relabeling that interruption as a takeover.
    params.clearRecovery("interrupted");
    return { status: "interrupted" };
  }
  if (!params.ownsRecovery()) {
    // Delivery completed, so retire only this submission's recovery record.
    // The callback's expected-key guard preserves any newer owner.
    params.clearRecovery("resolved");
    return { status: "ownership-lost" };
  }
  params.clearRecovery("resolved");
  return placementStart;
}
