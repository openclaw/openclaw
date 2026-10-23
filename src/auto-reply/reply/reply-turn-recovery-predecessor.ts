import {
  commitMainSessionRecovery,
  type MainSessionRecoveryStoreTarget,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
/** Foreground restart recovery ordered ahead of its already-selected inbound source. */
import { resolveRestartResendReservationId } from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { CommandLane } from "../../process/lanes.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { reserveSessionControllerClaimPredecessor } from "../../sessions/session-controller.mailbox-predecessor.js";
import {
  retireSessionControllerInput,
  type SessionControllerInput,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
} from "../../sessions/session-controller.stop.js";

type RestartRecoveryResult = Awaited<
  ReturnType<
    typeof import("../../agents/main-session-recovery/main-session-restart-recovery.js").retryRestartAbortedMainSessionRecovery
  >
>;

/** Dispatches the interrupted turn first, then waits until the inbound claim is restored. */
export async function retryRestartRecoveryBeforeSelectedClaim(params: {
  agentId?: string;
  cfg: OpenClawConfig;
  claim?: SessionControllerMailboxClaim;
  expectedRecoveryRunId?: string;
  expectedRecoverySourceRunId?: string;
  gatewayRuntime: GatewayRecoveryRuntime;
  lane?: CommandLane.Main | CommandLane.RestartRecovery;
  /** Durable resend identity; a live input with this ID is joined, never dispatched again. */
  reservationId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  upstreamAbortSignal?: AbortSignal;
}): Promise<RestartRecoveryResult | undefined> {
  const handoff = params.claim
    ? reserveSessionControllerClaimPredecessor(params.claim, {
        reservationId: params.reservationId,
        policy: { mode: "followup" },
        target: captureSessionTarget({
          storeScope: params.storePath,
          sessionKey: params.sessionKey,
          incarnation: params.sessionId,
          agentId: params.agentId,
        }),
        adapter: {
          signal: params.upstreamAbortSignal
            ? AbortSignal.any([params.claim.abortController.signal, params.upstreamAbortSignal])
            : params.claim.abortController.signal,
        },
      })
    : undefined;
  if (handoff && !handoff.created) {
    // Another dispatcher owns this resend; wait for it without a second dispatch or retirement.
    await handoff.restored;
    return undefined;
  }
  const input = handoff?.input;
  let recovery: RestartRecoveryResult;
  try {
    const { retryRestartAbortedMainSessionRecovery } =
      await import("../../agents/main-session-recovery/main-session-restart-recovery.js");
    recovery = await retryRestartAbortedMainSessionRecovery({
      agentId: params.agentId,
      cfg: params.cfg,
      controllerInput: input,
      expectedSessionId: params.sessionId,
      expectedRecoveryRunId: params.expectedRecoveryRunId,
      expectedRecoverySourceRunId: params.expectedRecoverySourceRunId,
      gatewayRuntime: params.gatewayRuntime,
      lane: params.lane,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  } finally {
    if (input && !input.custody.rpcAdopted) {
      retireSessionControllerInput(input);
    }
  }
  return handoff && !(await handoff.restored) ? undefined : recovery;
}

/** Startup's reserved resend identity, so a foreground claim joins that input instead of dispatching. */
export function resolveReservedRestartResendId(entry: InternalSessionEntry): string | undefined {
  const state = entry.mainRestartRecovery;
  return state?.reservation
    ? resolveRestartResendReservationId({
        sessionId: entry.sessionId,
        cycleId: state.cycleId,
        attempt: state.reservation.attempt,
      })
    : undefined;
}

/**
 * An explicit interrupt wins over a resend that has not started. Returns true when
 * admission must reload: a waiting resend input was cancelled as a Stop and records
 * its own outcome, a dispatched resend is still settling, or an undispatched one was
 * retired durably as stopped. Returns false, still holding admission, when the durable
 * row refuses retirement, so ordinary recovery ownership decides instead of a reload.
 */
export async function yieldToInterruptedRestartResend(params: {
  claim: SessionControllerMailboxClaim | undefined;
  entry: InternalSessionEntry | undefined;
  recoveryAdmissionRunId?: string;
  mailbox: { entries: readonly SessionControllerInput[] } | undefined;
  releaseAdmission: () => void;
  target: MainSessionRecoveryStoreTarget;
  waitForRecovery: () => Promise<void>;
}): Promise<boolean> {
  const { entry } = params;
  if (
    !entry ||
    // Redelivery of the interrupted claim must reach its existing admission guard.
    (params.recoveryAdmissionRunId !== undefined &&
      params.recoveryAdmissionRunId === entry.restartRecoveryDeliveryRunId) ||
    entry.mainRestartRecovery?.tombstone ||
    !params.claim?.inputs.some((input) => input.policy.mode === "interrupt")
  ) {
    return false;
  }
  const state = entry.mainRestartRecovery;
  // A prepared or admitted resend keeps its attempt number, so this identity finds its input.
  const reservationId = state?.chargedAttempts
    ? resolveRestartResendReservationId({
        sessionId: entry.sessionId,
        cycleId: state.cycleId,
        attempt: state.chargedAttempts,
      })
    : undefined;
  const waitingResend = params.mailbox?.entries.find(
    (input) =>
      reservationId !== undefined &&
      input.sourceTurnId === reservationId &&
      input.phase !== "consumed" &&
      !input.claim &&
      !input.retirementRequested,
  );
  if (waitingResend || state?.reservation) {
    params.releaseAdmission();
    if (waitingResend) {
      cancelCapturedSessionControllerSource(
        captureSessionControllerStop({ inputs: [waitingResend] }),
        { reason: "rpc" },
      );
    }
    await params.waitForRecovery();
    return true;
  }
  if (entry.abortedLastRun !== true) {
    return false;
  }
  const owed = await commitMainSessionRecovery({
    command: { kind: "interrupt_owed", now: Date.now() },
    expectedSessionId: entry.sessionId,
    requireWriteSuccess: true,
    target: params.target,
  });
  if (owed.transition.kind !== "applied") {
    // Nothing was retired, so a reload can select this same path again. Keep the
    // admission and let ordinary recovery ownership resolve the durable row instead.
    return false;
  }
  params.releaseAdmission();
  return true;
}
