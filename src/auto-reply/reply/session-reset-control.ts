// Fences explicit session resets against active work owned by another controller.
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { isIssuedTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import {
  collectSessionWorkAdmissionControlSnapshots,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createSteeringAuthorizationAffinity,
  steeringAuthorizationAffinitiesMatch,
} from "./steering-authorization-affinity.js";

export type ReplySessionResetControlFailureReason = "busy" | "unauthorized";

export class ReplySessionResetControlError extends Error {
  readonly reason: ReplySessionResetControlFailureReason;

  constructor(reason: ReplySessionResetControlFailureReason) {
    super(`session reset active-run control failed: ${reason}`);
    this.name = "ReplySessionResetControlError";
    this.reason = reason;
  }
}

export const REPLY_SESSION_RESET_CONTROL_UNAUTHORIZED_REPLY =
  "Session reset was not applied because active work is controlled by another controller. Retry after it finishes.";
export const REPLY_SESSION_RESET_CONTROL_BUSY_REPLY =
  "Session reset was not applied because active work could not be stopped safely. Retry.";

export function resolveReplySessionResetControlErrorReply(
  error: ReplySessionResetControlError,
): string {
  return error.reason === "unauthorized"
    ? REPLY_SESSION_RESET_CONTROL_UNAUTHORIZED_REPLY
    : REPLY_SESSION_RESET_CONTROL_BUSY_REPLY;
}

export type PreparedReplySessionResetControl = Readonly<{
  /** Recheck the exact captured run after lifecycle admissions have drained. */
  afterInterrupt: () => Promise<void>;
}>;

export type PrepareReplySessionResetControl = (target: {
  scope: string;
  sessionId: string;
  sessionKey: string;
}) => Promise<PreparedReplySessionResetControl | undefined>;

/**
 * Checks every foreign admission's immutable turn affinity, then aborts only the captured run.
 * The caller holds the lifecycle mutation fence across this preparation and its recheck.
 */
export async function prepareReplySessionResetActiveRunControl(params: {
  target: Readonly<{ scope: string; sessionId: string; sessionKey: string }>;
  turnAuthority?: TurnAuthoritySnapshot;
}): Promise<PreparedReplySessionResetControl | undefined> {
  const admissionSnapshots = collectSessionWorkAdmissionControlSnapshots({
    scope: params.target.scope,
    identities: [params.target.sessionKey, params.target.sessionId],
  });
  if (admissionSnapshots.length > 0 && !isIssuedTurnAuthoritySnapshot(params.turnAuthority)) {
    throw new ReplySessionResetControlError("busy");
  }
  const incomingAffinity = createSteeringAuthorizationAffinity({
    turnAuthority: params.turnAuthority,
  });
  for (const admission of admissionSnapshots) {
    if (!isIssuedTurnAuthoritySnapshot(admission.turnAuthority)) {
      throw new ReplySessionResetControlError("busy");
    }
    const admissionAffinity = createSteeringAuthorizationAffinity({
      turnAuthority: admission.turnAuthority,
    });
    if (!steeringAuthorizationAffinitiesMatch(admissionAffinity, incomingAffinity)) {
      throw new ReplySessionResetControlError("unauthorized");
    }
  }

  const runtime = await import("../../agents/embedded-agent.runtime.js");
  const activeSessionId = runtime.resolveActiveEmbeddedRunSessionId(params.target.sessionKey);
  if (!activeSessionId) {
    return undefined;
  }
  if (activeSessionId !== params.target.sessionId) {
    throw new ReplySessionResetControlError("busy");
  }

  const outcome = runtime.abortActiveRunWithSteeringAuthorization({
    sessionId: activeSessionId,
    steeringAuthorizationAffinity: incomingAffinity,
    policy: "exact",
  });
  if (outcome.status === "not_active") {
    const replacement = runtime.resolveActiveEmbeddedRunSessionId(params.target.sessionKey);
    if (replacement) {
      throw new ReplySessionResetControlError("busy");
    }
    return undefined;
  }
  if (outcome.status === "unauthorized") {
    throw new ReplySessionResetControlError("unauthorized");
  }
  if (outcome.status !== "aborted" || outcome.replacementObserved) {
    throw new ReplySessionResetControlError("busy");
  }

  return Object.freeze({
    afterInterrupt: async () => {
      if (runtime.authorizedActiveRunAbortObservedReplacement(outcome)) {
        throw new ReplySessionResetControlError("busy");
      }
      const drained = await runtime.waitForEmbeddedAgentRunEnd(
        activeSessionId,
        SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      );
      if (
        !drained ||
        runtime.authorizedActiveRunAbortObservedReplacement(outcome) ||
        runtime.resolveActiveEmbeddedRunSessionId(params.target.sessionKey)
      ) {
        throw new ReplySessionResetControlError("busy");
      }
    },
  });
}
