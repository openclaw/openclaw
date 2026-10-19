import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.identity.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  bindSessionControllerEntryTarget,
  findSessionControllerEntry,
  getSessionControllerEntry,
} from "../../sessions/session-controller.state.js";
import type { ReplyTurnAdmissionParams } from "./reply-turn-admission.types.js";

/** Bind admission to one physical controller before waiting or adopting an operation. */
export function resolveReplyTurnController(
  params: Pick<
    ReplyTurnAdmissionParams,
    "storePath" | "sessionKey" | "agentId" | "adoptOperation" | "mailboxClaim"
  >,
) {
  const target = params.storePath
    ? captureSessionTarget({
        storeScope: params.storePath,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      })
    : undefined;
  if (target && params.adoptOperation) {
    const adoptedTarget = getSessionControllerEntryForOperation(params.adoptOperation).target;
    if (adoptedTarget && adoptedTarget.storeScope !== target.storeScope) {
      throw new Error("Reply operation cannot move between physical stores");
    }
  }
  const controller =
    params.mailboxClaim?.mailbox.owner ??
    findSessionControllerEntry(params.sessionKey, target) ??
    getSessionControllerEntry(params.sessionKey, target);
  if (target && !controller.target) {
    bindSessionControllerEntryTarget(controller, target);
  }
  if (target && controller.target?.storeScope !== target.storeScope) {
    throw new Error("Reply claim belongs to a different physical store");
  }
  return controller;
}
