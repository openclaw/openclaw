import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import type { SessionAdmissionTransition } from "../config/sessions/session-admission-transition.types.js";
import { agentSessionKeysMatchByRequestKey } from "../routing/session-key.js";
import type { ReplyOperation } from "./session-controller.contracts.js";
import { acknowledgeSessionEffectTransition } from "./session-controller.owner-context.js";
import { lifecycleAdmissionByOperation } from "./session-controller.storage.js";
import type { SessionTarget } from "./session-controller.target.js";

/** Borrow only the exact admitted operation, never a replacement selected by key. */
export function getReplyOperationSessionReader(operation: ReplyOperation | undefined) {
  return operation ? lifecycleAdmissionByOperation.get(operation)?.reader : undefined;
}
export function getReplyOperationSessionTarget(operation: ReplyOperation | undefined) {
  return operation
    ? lifecycleAdmissionByOperation.get(operation)?.resolveSessionTarget?.()
    : undefined;
}
export function acquireReplyOperationSessionActor(
  operation: ReplyOperation,
): Promise<SessionActor | undefined> {
  const admission = lifecycleAdmissionByOperation.get(operation);
  if (!admission?.acquireSessionActor) {
    throw new Error("Reply operation has no session actor admission");
  }
  return admission.acquireSessionActor();
}
export function captureReplyOperationSessionReader(operation: ReplyOperation | undefined) {
  return operation ? lifecycleAdmissionByOperation.get(operation)?.resolveReader : undefined;
}
export function acknowledgeReplySessionTransition(
  operation: ReplyOperation | undefined,
  transition: SessionAdmissionTransition,
  target?: SessionTarget,
) {
  if (target) {
    acknowledgeSessionEffectTransition(target, transition);
    // A case-preserving thread id and the folded store key are one session.
    // An exact compare skips this handoff, so the admitted reader still expects
    // the pre-fork incarnation and the next read reports that it changed.
    const sameSession = agentSessionKeysMatchByRequestKey(operation?.key, target.sessionKey);
    if (
      !sameSession ||
      (transition.previous?.sessionId === transition.current.sessionId &&
        transition.previous?.lifecycleRevision === transition.current.lifecycleRevision)
    ) {
      return undefined;
    }
  }
  return operation
    ? lifecycleAdmissionByOperation.get(operation)?.afterTransition?.(transition)
    : undefined;
}
